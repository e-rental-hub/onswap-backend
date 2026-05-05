import { Response }    from 'express';
import mongoose        from 'mongoose';
import { Order }       from '../models/Order';
import { Ad }          from '../models/Ad';
import { User }        from '../models/User';
import { AuthRequest } from '../middleware/auth';
import {
  lockForEscrow,
  releaseEscrow,
  refundEscrow,
  reserveForAd,
} from '../services/walletService';
import { logger } from '../utils/logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const POPULATE_ORDER = [
  { path: 'buyer',  select: 'username displayName rating totalTrades completedTrades kycVerified piBalance' },
  { path: 'seller', select: 'username displayName rating totalTrades completedTrades kycVerified' },
  { path: 'ad',     select: 'type paymentDetails paymentWindow terms autoReply paymentMethods' },
];

// ─── POST /orders ─────────────────────────────────────────────────────────────
//
// Creates a new P2P order against an existing ad.
//
// Sell-ad flow (creator sells Pi, new user buys):
//   • Pi is already locked in seller's lockedBalance from ad creation.
//   • We decrement ad.availableAmount and write an escrow audit row.
//   • Buyer has no wallet interaction — they just need to send Naira.
//
// Buy-ad flow (creator wants to buy Pi, new user is the Pi seller):
//   • The incoming user IS the Pi seller.
//   • We must lock their piBalance for this order (reserveForAd semantics but
//     for an order-level lock, not an ad-level one).
//   • If their piBalance < piAmount, the frontend showed them the deposit modal
//     first; this endpoint is only reached once balance is confirmed.

export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId                         = req.user!.id;
    const { adId, piAmount, paymentMethod } = req.body as {
      adId: string; piAmount: number; paymentMethod: string;
    };

    const ad = await Ad.findById(adId).session(session);
    if (!ad || ad.status !== 'active') {
      await session.abortTransaction();
      res.status(404).json({ success: false, message: 'Ad not found or not active' });
      return;
    }

    if (ad.creator.toString() === userId) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Cannot trade with your own ad' });
      return;
    }

    // Validate piAmount within ad limits
    const nairaAmount = Math.round(piAmount * ad.pricePerPi * 100) / 100;
    if (nairaAmount < ad.minLimit || nairaAmount > ad.maxLimit) {
      await session.abortTransaction();
      res.status(400).json({
        success: false,
        message: `Naira amount ₦${nairaAmount.toLocaleString()} must be between ₦${ad.minLimit.toLocaleString()} and ₦${ad.maxLimit.toLocaleString()}`,
      });
      return;
    }

    if (piAmount > ad.availableAmount) {
      await session.abortTransaction();
      res.status(400).json({
        success: false,
        message: `Only ${ad.availableAmount}π available in this ad`,
      });
      return;
    }

    if (!ad.paymentMethods.includes(paymentMethod as never)) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Payment method not supported by this ad' });
      return;
    }

    // Determine buyer/seller roles based on ad type
    const isSellAd = ad.type === 'sell';
    const buyerId  = isSellAd ? new mongoose.Types.ObjectId(userId) : ad.creator;
    const sellerId = isSellAd ? ad.creator : new mongoose.Types.ObjectId(userId);

    // Buy-ad: the incoming user (pi seller) must have sufficient balance
    if (!isSellAd) {
      const piSeller = await User.findById(userId).session(session);
      if (!piSeller || piSeller.piBalance < piAmount) {
        await session.abortTransaction();
        res.status(400).json({
          success:      false,
          message:      'Insufficient Pi balance to fill this buy ad.',
          required:     piAmount,
          available:    piSeller?.piBalance ?? 0,
          shortfall:    piAmount - (piSeller?.piBalance ?? 0),
          needsDeposit: true,
        });
        return;
      }
    }

    // Decrement ad available amount
    ad.availableAmount -= piAmount;
    if (ad.availableAmount <= 0) ad.status = 'completed';
    // For sell ads: update reservedPi to match remaining available
    if (isSellAd) ad.reservedPi = ad.availableAmount;
    await ad.save({ session });

    const paymentDeadline = new Date(Date.now() + ad.paymentWindow * 60 * 1000);

    const [order] = await Order.create(
      [{
        ad:     ad._id,
        buyer:  buyerId,
        seller: sellerId,
        piAmount,
        nairaAmount,
        pricePerPi:    ad.pricePerPi,
        currency:      ad.currency,
        paymentMethod,
        status:         'payment_pending',
        escrow: {
          piAmount,
          status:   'locked',
          lockedAt: new Date(),
          txId:     `ESC-${Date.now()}`,
        },
        paymentDeadline,
        messages: [{
          sender:    buyerId,
          content:   `Order created. Buyer must pay ₦${nairaAmount.toLocaleString()} within ${ad.paymentWindow} minutes.`,
          type:      'system',
          timestamp: new Date(),
        }],
      }],
      { session }
    );

    // Wallet operations
    if (isSellAd) {
      // Pi already in seller's lockedBalance from ad creation — audit only
      await lockForEscrow(
        session,
        sellerId,
        req.user!.piUid,
        piAmount,
        order._id as mongoose.Types.ObjectId,
        ad._id as mongoose.Types.ObjectId,
      );
    } else {
      // Buy-ad: lock the Pi-seller's (incoming user's) piBalance for this order
      await reserveForAd(
        session,
        new mongoose.Types.ObjectId(userId),
        req.user!.piUid,
        piAmount,
        order._id as mongoose.Types.ObjectId,
      );
    }

    await session.commitTransaction();

    await order.populate(POPULATE_ORDER);

    logger.info(`Order ${order._id} created: ${piAmount}π for ₦${nairaAmount} (${ad.type} ad)`);
    res.status(201).json({ success: true, order });
  } catch (err) {
    await session.abortTransaction();
    logger.error('createOrder error:', err);
    const message = err instanceof Error ? err.message : 'Failed to create order';
    res.status(500).json({ success: false, message });
  } finally {
    session.endSession();
  }
};

// ─── GET /orders ──────────────────────────────────────────────────────────────

export const getOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { status, role } = req.query;

    const filter: Record<string, unknown> = {};
    if (role === 'buyer')  filter.buyer  = userId;
    else if (role === 'seller') filter.seller = userId;
    else filter.$or = [{ buyer: userId }, { seller: userId }];
    if (status) filter.status = status;

    const orders = await Order.find(filter)
      .populate('buyer',  'username displayName rating')
      .populate('seller', 'username displayName rating')
      .populate('ad',     'type paymentDetails paymentMethods')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ success: true, orders });
  } catch (err) {
    logger.error('getOrders error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
};

// ─── GET /orders/:id ──────────────────────────────────────────────────────────

export const getOrderById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const order  = await Order.findById(req.params.id).populate(POPULATE_ORDER);

    if (!order) { res.status(404).json({ success: false, message: 'Order not found' }); return; }

    const isParticipant =
      order.buyer.toString()  === userId ||
      order.seller.toString() === userId;
    if (!isParticipant) { res.status(403).json({ success: false, message: 'Unauthorized' }); return; }

    res.json({ success: true, order });
  } catch (err) {
    logger.error('getOrderById error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
};

// ─── PATCH /orders/:id/status ─────────────────────────────────────────────────

export const updateOrderStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = req.user!.id;
    const { action, reason } = req.body as { action: string; reason?: string };

    const order = await Order.findById(req.params.id)
      .session(session)
      .populate('buyer',  'username piUid')
      .populate('seller', 'username piUid');

    if (!order) { await session.abortTransaction(); res.status(404).json({ success: false, message: 'Order not found' }); return; }

    const isBuyer  = (order.buyer as unknown as { _id: mongoose.Types.ObjectId })._id.toString() === userId;
    const isSeller = (order.seller as unknown as { _id: mongoose.Types.ObjectId })._id.toString() === userId;
    if (!isBuyer && !isSeller) { await session.abortTransaction(); res.status(403).json({ success: false, message: 'Unauthorized' }); return; }

    const sellerId  = (order.seller as unknown as { _id: mongoose.Types.ObjectId; piUid: string });
    const ad        = await Ad.findById(order.ad).session(session);

    let systemMsg = '';

    switch (action) {

      case 'confirm_payment':
        if (!isBuyer) { await session.abortTransaction(); res.status(403).json({ success: false, message: 'Only buyer can confirm payment' }); return; }
        if (order.status !== 'payment_pending') { await session.abortTransaction(); res.status(400).json({ success: false, message: 'Invalid order state for this action' }); return; }
        order.status = 'payment_sent';
        systemMsg = '✅ Buyer confirmed payment. Seller — verify receipt and release Pi.';
        break;

      case 'release_escrow':
        if (!isSeller) { await session.abortTransaction(); res.status(403).json({ success: false, message: 'Only seller can release escrow' }); return; }
        if (order.status !== 'payment_sent') { await session.abortTransaction(); res.status(400).json({ success: false, message: 'Awaiting buyer payment confirmation first' }); return; }

        order.status        = 'completed';
        order.escrow.status = 'released';
        order.escrow.releasedAt = new Date();
        order.completedAt   = new Date();
        systemMsg = '🎉 Pi released! Trade completed successfully.';

        // Release Pi from seller's lockedBalance (Pi leaves app to buyer)
        await releaseEscrow(
          session,
          sellerId._id,
          sellerId.piUid,
          order.piAmount,
          order._id as mongoose.Types.ObjectId,
        );

        // Update user trade stats
        await User.findByIdAndUpdate(order.buyer,  { $inc: { totalTrades: 1, completedTrades: 1 } }, { session });
        await User.findByIdAndUpdate(order.seller, { $inc: { totalTrades: 1, completedTrades: 1 } }, { session });

        // Increment ad completed orders
        if (ad) await Ad.findByIdAndUpdate(ad._id, { $inc: { completedOrders: 1 } }, { session });
        break;

      case 'cancel':
        if (order.status === 'completed' || order.status === 'disputed') {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'Cannot cancel a completed or disputed order' });
          return;
        }
        if (order.status === 'payment_sent' && isBuyer) {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'You have already confirmed payment. Raise a dispute if there is an issue.' });
          return;
        }

        order.status        = 'cancelled';
        order.cancelledAt   = new Date();
        order.cancelReason  = reason;
        order.escrow.status = 'refunded';
        systemMsg = `Order cancelled.${reason ? ` Reason: ${reason}` : ''}`;

        // Refund Pi back to the ad's available pool
        if (ad) {
          ad.availableAmount += order.piAmount;
          if (ad.type === 'sell') ad.reservedPi = ad.availableAmount;
          if (ad.status === 'completed') ad.status = 'active'; // re-open if it was auto-completed
          await ad.save({ session });
        }

        // Audit escrow refund (no balance movement for sell-ads — Pi stays in lockedBalance for the ad)
        await refundEscrow(
          session,
          sellerId._id,
          sellerId.piUid,
          order.piAmount,
          order._id as mongoose.Types.ObjectId,
        );
        break;

      case 'dispute':
        if (!['payment_pending', 'payment_sent'].includes(order.status)) {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'Cannot dispute this order in its current state' });
          return;
        }
        order.status        = 'disputed';
        order.disputeReason = reason;
        systemMsg = `⚠️ Dispute raised: "${reason}". Admin will review within 24 hours.`;
        break;

      default:
        await session.abortTransaction();
        res.status(400).json({ success: false, message: `Unknown action: ${action}` });
        return;
    }

    if (systemMsg) {
      order.messages.push({
        sender:    new mongoose.Types.ObjectId(userId),
        content:   systemMsg,
        type:      'system',
        timestamp: new Date(),
      });
    }

    await order.save({ session });
    await session.commitTransaction();

    await order.populate(POPULATE_ORDER);

    logger.info(`Order ${order._id} action="${action}" by ${req.user!.username}`);
    res.json({ success: true, order });
  } catch (err) {
    await session.abortTransaction();
    logger.error('updateOrderStatus error:', err);
    const message = err instanceof Error ? err.message : 'Failed to update order';
    res.status(500).json({ success: false, message });
  } finally {
    session.endSession();
  }
};

// ─── POST /orders/:id/messages ────────────────────────────────────────────────

export const sendMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { content, type, imageUrl } = req.body as { content: string; type?: string; imageUrl?: string };

    const order = await Order.findById(req.params.id);
    if (!order) { res.status(404).json({ success: false, message: 'Order not found' }); return; }

    const isParticipant =
      order.buyer.toString()  === userId ||
      order.seller.toString() === userId;
    if (!isParticipant) { res.status(403).json({ success: false, message: 'Unauthorized' }); return; }

    if (['completed', 'cancelled'].includes(order.status)) {
      res.status(400).json({ success: false, message: 'Cannot send messages on a closed order' });
      return;
    }

    order.messages.push({
      sender:    new mongoose.Types.ObjectId(userId),
      content,
      type:      (type as 'text' | 'system' | 'payment_proof') || 'text',
      timestamp: new Date(),
      imageUrl,
    });

    await order.save();
    const msg = order.messages[order.messages.length - 1];
    res.json({ success: true, message: msg });
  } catch (err) {
    logger.error('sendMessage error:', err);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
};