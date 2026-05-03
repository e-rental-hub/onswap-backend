import { Response } from 'express';
import mongoose from 'mongoose';
import { Order } from '../models/Order';
import { Ad } from '../models/Ad';
import { User } from '../models/User';
import { AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { adId, piAmount, paymentMethod } = req.body;
    const buyerId = req.user!.id;

    const ad = await Ad.findById(adId).session(session);
    if (!ad || ad.status !== 'active') {
      await session.abortTransaction();
      res.status(404).json({ success: false, message: 'Ad not found or inactive' });
      return;
    }

    if (ad.creator.toString() === buyerId) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Cannot trade with your own ad' });
      return;
    }

    const nairaAmount = piAmount * ad.pricePerPi;
    if (nairaAmount < ad.minLimit || nairaAmount > ad.maxLimit) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: `Amount must be between ₦${ad.minLimit} and ₦${ad.maxLimit}` });
      return;
    }

    if (piAmount > ad.availableAmount) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Insufficient Pi available in this ad' });
      return;
    }

    const isBuyAd = ad.type === 'buy';
    const buyer = isBuyAd ? ad.creator : new mongoose.Types.ObjectId(buyerId);
    const seller = isBuyAd ? new mongoose.Types.ObjectId(buyerId) : ad.creator;

    // Lock Pi in escrow
    ad.availableAmount -= piAmount;
    if (ad.availableAmount === 0) ad.status = 'completed';
    await ad.save({ session });

    const paymentDeadline = new Date(Date.now() + ad.paymentWindow * 60 * 1000);

    const [order] = await Order.create(
      [
        {
          ad: ad._id,
          buyer,
          seller,
          piAmount,
          nairaAmount,
          pricePerPi: ad.pricePerPi,
          currency: ad.currency,
          paymentMethod,
          status: 'payment_pending',
          escrow: { piAmount, status: 'locked', lockedAt: new Date(), txId: `ESC-${Date.now()}` },
          paymentDeadline,
          messages: [{ sender: buyer, content: `Order created. Please pay ₦${nairaAmount.toLocaleString()} within ${ad.paymentWindow} minutes.`, type: 'system', timestamp: new Date() }],
        },
      ],
      { session }
    );

    await session.commitTransaction();

    await order.populate([
      { path: 'buyer', select: 'username displayName rating' },
      { path: 'seller', select: 'username displayName rating' },
      { path: 'ad', select: 'paymentDetails paymentWindow' },
    ]);

    logger.info(`Order ${order._id} created: ${piAmount} Pi for ₦${nairaAmount}`);
    res.status(201).json({ success: true, order });
  } catch (error) {
    await session.abortTransaction();
    logger.error('CreateOrder error:', error);
    res.status(500).json({ success: false, message: 'Failed to create order' });
  } finally {
    session.endSession();
  }
};

export const getOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { status, role } = req.query;
    const filter: Record<string, unknown> = {};

    if (role === 'buyer') filter.buyer = userId;
    else if (role === 'seller') filter.seller = userId;
    else filter.$or = [{ buyer: userId }, { seller: userId }];

    if (status) filter.status = status;

    const orders = await Order.find(filter)
      .populate('buyer', 'username displayName rating')
      .populate('seller', 'username displayName rating')
      .populate('ad', 'type paymentDetails')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ success: true, orders });
  } catch (error) {
    logger.error('GetOrders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
};

export const getOrderById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const order = await Order.findById(req.params.id)
      .populate('buyer', 'username displayName rating kycVerified totalTrades')
      .populate('seller', 'username displayName rating kycVerified totalTrades')
      .populate('ad', 'paymentDetails paymentWindow terms autoReply type');

    if (!order) { res.status(404).json({ success: false, message: 'Order not found' }); return; }

    const isParticipant = order.buyer._id.toString() === userId || order.seller._id.toString() === userId;
    if (!isParticipant) { res.status(403).json({ success: false, message: 'Unauthorized' }); return; }

    res.json({ success: true, order });
  } catch (error) {
    logger.error('GetOrderById error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
};

export const updateOrderStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = req.user!.id;
    const { action, reason } = req.body;

    const order = await Order.findById(req.params.id).session(session)
      .populate('buyer', 'username')
      .populate('seller', 'username');

    if (!order) { await session.abortTransaction(); res.status(404).json({ success: false, message: 'Order not found' }); return; }

    const isBuyer = order.buyer._id.toString() === userId;
    const isSeller = order.seller._id.toString() === userId;
    if (!isBuyer && !isSeller) { await session.abortTransaction(); res.status(403).json({ success: false, message: 'Unauthorized' }); return; }

    let systemMsg = '';

    switch (action) {
      case 'confirm_payment':
        if (!isBuyer) { await session.abortTransaction(); res.status(403).json({ success: false, message: 'Only buyer can confirm payment' }); return; }
        if (order.status !== 'payment_pending') { await session.abortTransaction(); res.status(400).json({ success: false, message: 'Invalid order state' }); return; }
        order.status = 'payment_sent';
        systemMsg = 'Buyer has confirmed payment. Seller please verify and release Pi.';
        break;

      case 'release_escrow':
        if (!isSeller) { await session.abortTransaction(); res.status(403).json({ success: false, message: 'Only seller can release escrow' }); return; }
        if (order.status !== 'payment_sent') { await session.abortTransaction(); res.status(400).json({ success: false, message: 'Awaiting payment confirmation' }); return; }
        order.status = 'completed';
        order.escrow.status = 'released';
        order.escrow.releasedAt = new Date();
        order.completedAt = new Date();
        systemMsg = '✅ Pi released from escrow. Trade completed successfully!';

        // Update user stats
        await User.findByIdAndUpdate(order.buyer._id, { $inc: { totalTrades: 1, completedTrades: 1 } }, { session });
        await User.findByIdAndUpdate(order.seller._id, { $inc: { totalTrades: 1, completedTrades: 1 } }, { session });
        await Ad.findByIdAndUpdate(order.ad, { $inc: { completedOrders: 1 } }, { session });
        break;

      case 'cancel':
        if (order.status === 'completed' || order.status === 'disputed') {
          await session.abortTransaction(); res.status(400).json({ success: false, message: 'Cannot cancel this order' }); return;
        }
        order.status = 'cancelled';
        order.cancelledAt = new Date();
        order.cancelReason = reason;
        order.escrow.status = 'refunded';
        systemMsg = `Order cancelled. ${reason ? `Reason: ${reason}` : ''}`;

        // Return Pi to ad
        await Ad.findByIdAndUpdate(order.ad, { $inc: { availableAmount: order.piAmount }, status: 'active' }, { session });
        break;

      case 'dispute':
        if (order.status !== 'payment_sent' && order.status !== 'payment_pending') {
          await session.abortTransaction(); res.status(400).json({ success: false, message: 'Cannot dispute this order' }); return;
        }
        order.status = 'disputed';
        order.disputeReason = reason;
        systemMsg = `⚠️ Dispute raised. Admin will review. Reason: ${reason}`;
        break;

      default:
        await session.abortTransaction(); res.status(400).json({ success: false, message: 'Invalid action' }); return;
    }

    if (systemMsg) {
      order.messages.push({ sender: new mongoose.Types.ObjectId(userId), content: systemMsg, type: 'system', timestamp: new Date() });
    }

    await order.save({ session });
    await session.commitTransaction();

    logger.info(`Order ${order._id} action: ${action} by ${req.user!.username}`);
    res.json({ success: true, order });
  } catch (error) {
    await session.abortTransaction();
    logger.error('UpdateOrderStatus error:', error);
    res.status(500).json({ success: false, message: 'Failed to update order' });
  } finally {
    session.endSession();
  }
};

export const sendMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { content, type, imageUrl } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) { res.status(404).json({ success: false, message: 'Order not found' }); return; }

    const isParticipant = order.buyer.toString() === userId || order.seller.toString() === userId;
    if (!isParticipant) { res.status(403).json({ success: false, message: 'Unauthorized' }); return; }

    order.messages.push({ sender: new mongoose.Types.ObjectId(userId), content, type: type || 'text', timestamp: new Date(), imageUrl });
    await order.save();

    const msg = order.messages[order.messages.length - 1];
    res.json({ success: true, message: msg });
  } catch (error) {
    logger.error('SendMessage error:', error);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
};
