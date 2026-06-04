import { Response }    from 'express';
import mongoose        from 'mongoose';
import { IMessage, Order }       from '../models/Order';
import { Ad }          from '../models/Ad';
import { User }        from '../models/User';
import { AuthRequest } from '../middleware/auth';
import {
  lockForEscrow,
  releaseEscrow,
  refundOrderReservation,
  reserveForAd,
} from '../services/walletService';
import { logger }        from '../utils/logger';
import { releaseToUser } from '../services/piNetwork.service';
import { config }        from '../config';
import { AdStatusEnum, AdTypeEnum, EscrowStatusEnum, MessageTypeEnum, OrderStatusEnum, PaymentMethodEnum } from '../models/enum';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const POPULATE_ORDER = [
  { path: 'buyer',  select: 'username displayName rating totalTrades completedTrades kycVerified piBalance piUid' },
  { path: 'seller', select: 'username displayName rating totalTrades completedTrades kycVerified piUid' },
  { path: 'ad',     select: 'type paymentDetails paymentWindow terms autoReply paymentMethods' },
];

/**
 * Extract a plain string ID from a field that may be either a raw ObjectId
 * (before populate) or a full populated Mongoose document (after populate).
 */
function toId(field: unknown): string {
  if (field == null) return '';
  if (typeof field === 'object' && '_id' in (field as object)) {
    return (field as { _id: { toString(): string } })._id.toString();
  }
  return String(field);
}

// ─── POST /orders ─────────────────────────────────────────────────────────────

export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = req.user!.id;
    const {
      adId,
      piAmount,
      paymentMethod,
      sellerAccountDetailId,
      buyerWalletAddressId,
    } = req.body as {
      adId:                  string;
      piAmount:              number;
      paymentMethod:         string;
      sellerAccountDetailId: string;
      buyerWalletAddressId:  string;
    };

    // Both IDs are mandatory for every order
    if (!sellerAccountDetailId && !buyerWalletAddressId) {
      await session.abortTransaction();
      res.status(400).json({
        success: false,
        message: 'Both sellerAccountDetailId and buyerWalletAddressId are required to create an order.',
      });
      return;
    }

    const ad = await Ad.findById(adId).session(session);
    if (!ad || ad.status !== AdStatusEnum.active) {
      await session.abortTransaction();
      res.status(404).json({ success: false, message: 'Ad not found or not active' });
      return;
    }

    if (config.nodeEnv === 'production' && ad.creator.toString() === userId) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Cannot trade with your own ad' });
      return;
    }

    if (!ad.paymentMethods.includes(paymentMethod as PaymentMethodEnum)) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Payment method not supported by this ad' });
      return;
    }

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

    const isSellAd = ad.type === AdTypeEnum.sell;
    const buyerId  = isSellAd ? new mongoose.Types.ObjectId(userId) : ad.creator;
    const sellerId = isSellAd ? ad.creator                          : new mongoose.Types.ObjectId(userId);

    // ── Resolve sellerAccountDetail snapshot ──────────────────────────────
    let sellerAccountDetail: typeof ad.sellerAccountDetail;

    if (isSellAd) {
      if (!ad.sellerAccountDetail) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'This sell ad has no payment account on record.' });
        return;
      }
      sellerAccountDetail = ad.sellerAccountDetail;
    } else {
      const piSeller = await User.findById(userId).session(session);
      if (!piSeller) {
        await session.abortTransaction();
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      if (piSeller.piBalance < piAmount) {
        await session.abortTransaction();
        res.status(400).json({
          success:      false,
          message:      'Insufficient Pi balance to fill this buy ad.',
          required:     piAmount,
          available:    piSeller.piBalance,
          shortfall:    piAmount - piSeller.piBalance,
          needsDeposit: true,
        });
        return;
      }

      const savedAccount = piSeller.userAccountDetails.id(sellerAccountDetailId);
      if (!savedAccount) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'Seller account detail not found in your profile.' });
        return;
      }

      sellerAccountDetail = {
        type:          savedAccount.type,
        label:         savedAccount.label,
        accountName:   savedAccount.accountName,
        accountNumber: savedAccount.accountNumber,
        bankName:      savedAccount.bankName,
      };
    }

    // ── Resolve buyerWalletAddress ────────────────────────────────────────
    let buyerWalletAddress: string;

    if (isSellAd) {
      const piBuyer = await User.findById(userId).session(session);
      if (!piBuyer) {
        await session.abortTransaction();
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const savedWallet = piBuyer.piWalletAddresses.id(buyerWalletAddressId);
      if (!savedWallet) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'Buyer Pi wallet address not found in your profile.' });
        return;
      }

      buyerWalletAddress = savedWallet.address;
    } else {
      if (!ad.buyerWalletAddress) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'This buy ad has no Pi wallet address on record.' });
        return;
      }
      buyerWalletAddress = ad.buyerWalletAddress;
    }

    // ── Decrement ad available amount ─────────────────────────────────────
    ad.availableAmount -= piAmount;
    if (ad.availableAmount <= 0) ad.status = AdStatusEnum.completed;
    if (isSellAd) ad.reservedPi = ad.availableAmount;
    await ad.save({ session });

    const paymentDeadline = new Date(Date.now() + ad.paymentWindow * 60 * 1000);

    const initialMessages: IMessage[] = [
      {
        sender:    buyerId,
        content:   `Order created. Buyer must pay ₦${nairaAmount.toLocaleString()} within ${ad.paymentWindow} minutes.`,
        type:      MessageTypeEnum.system,
        timestamp: new Date(),
      },
    ];

    if (ad.autoReply) {
      initialMessages.push({
        sender:    ad.creator,
        content:   ad.autoReply,
        type:      MessageTypeEnum.text,
        timestamp: new Date(),
      });
    }

    const order = new Order({
      ad:     ad._id,
      buyer:  buyerId,
      seller: sellerId,
      piAmount,
      nairaAmount,
      pricePerPi:          ad.pricePerPi,
      currency:            ad.currency,
      paymentMethod:       paymentMethod as PaymentMethodEnum,
      sellerAccountDetail,
      buyerWalletAddress,
      status:              OrderStatusEnum.paymentPending,
      escrow: {
        piAmount,
        status:   EscrowStatusEnum.locked,
        lockedAt: new Date(),
        txId:     `ESC-${Date.now()}`,
      },
      paymentDeadline,
      messages: initialMessages,
    });

    await order.save({ session });

    // ── Wallet operations ─────────────────────────────────────────────────
    if (isSellAd) {
      await lockForEscrow(
        session,
        sellerId,
        req.user!.piUid,
        piAmount,
        order._id as mongoose.Types.ObjectId,
        ad._id as mongoose.Types.ObjectId,
      );
    } else {
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
    if (role === 'buyer')       filter.buyer  = userId;
    else if (role === 'seller') filter.seller = userId;
    else                        filter.$or = [{ buyer: userId }, { seller: userId }];
    if (status) filter.status = status;

    const orders = await Order.find(filter)
      .populate('buyer',  'username displayName rating')
      .populate('seller', 'username displayName rating')
      .populate('ad',     'type paymentMethods paymentWindow')
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

    const raw = await Order.findById(req.params.id);
    if (!raw) { res.status(404).json({ success: false, message: 'Order not found' }); return; }

    const isParticipant =
      raw.buyer.toString()  === userId ||
      raw.seller.toString() === userId;
    if (!isParticipant) { res.status(403).json({ success: false, message: 'Unauthorized' }); return; }

    const order = await raw.populate(POPULATE_ORDER);
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

    if (!order) {
      await session.abortTransaction();
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    const isBuyer  = toId(order.buyer)  === userId;
    const isSeller = toId(order.seller) === userId;
    if (!isBuyer && !isSeller) {
      await session.abortTransaction();
      res.status(403).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const sellerDoc = order.seller as unknown as { _id: mongoose.Types.ObjectId; piUid: string };
    const ad        = await Ad.findById(order.ad).session(session);

    // ── Guard: sellerDoc must be resolvable ───────────────────────────────
    if (!sellerDoc?._id) {
      await session.abortTransaction();
      res.status(500).json({ success: false, message: 'Could not resolve seller from order. Please try again.' });
      return;
    }

    let systemMsg = '';

    switch (action) {

      // ── confirm_payment ─────────────────────────────────────────────────
      // Only the buyer may confirm. Allowed only from paymentPending.
      case 'confirm_payment':
        if (!isBuyer) {
          await session.abortTransaction();
          res.status(403).json({ success: false, message: 'Only buyer can confirm payment' });
          return;
        }
        if (order.status !== OrderStatusEnum.paymentPending) {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'Invalid order state for this action' });
          return;
        }
        order.status = OrderStatusEnum.paymentSent;
        systemMsg = '✅ Buyer confirmed payment. Seller — verify receipt and release Pi.';
        break;

      // ── release_escrow ──────────────────────────────────────────────────
      // Only the seller may release. Buyer must have confirmed payment first.
      case 'release_escrow': {
        if (!isSeller) {
          await session.abortTransaction();
          res.status(403).json({ success: false, message: 'Only seller can release escrow' });
          return;
        }
        if (order.status !== OrderStatusEnum.paymentSent) {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'Awaiting buyer payment confirmation first' });
          return;
        }

        const buyerWalletAddr = (order as unknown as { buyerWalletAddress?: string }).buyerWalletAddress;
        if (!buyerWalletAddr) {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'Buyer wallet address not on this order — cannot release Pi' });
          return;
        }

        // Abort the DB session before the on-chain call.
        await session.abortTransaction();
        session.endSession();

        const releaseResult = await releaseToUser(
          buyerWalletAddr,
          order.piAmount,
          order._id.toString(),
        );

        if (!releaseResult.success) {
          logger.error(`release_escrow: on-chain transfer failed for order ${order._id}`, releaseResult);
          res.status(502).json({
            success:          false,
            message:          `Pi transfer failed: ${releaseResult.error ?? 'Unknown error'}. Order NOT marked complete. Please retry or contact support.`,
            recipientAddress: releaseResult.recipientAddress,
            txid:             releaseResult.txid,
          });
          return;
        }

        const dbSession = await mongoose.startSession();
        dbSession.startTransaction();
        try {
          const freshOrder = await Order.findById(order._id).session(dbSession);
          if (!freshOrder) throw new Error('Order disappeared after on-chain transfer');

          freshOrder.status            = OrderStatusEnum.completed;
          freshOrder.escrow.status     = EscrowStatusEnum.released;
          freshOrder.escrow.releasedAt = new Date();
          freshOrder.escrow.txId       = releaseResult.txid;
          freshOrder.completedAt       = new Date();
          freshOrder.messages.push({
            sender:    new mongoose.Types.ObjectId(userId),
            content:   `🎉 Pi released on-chain! txid: ${releaseResult.txid}`,
            type:      MessageTypeEnum.system,
            timestamp: new Date(),
          });
          await freshOrder.save({ session: dbSession });

          await releaseEscrow(
            dbSession,
            sellerDoc._id,
            sellerDoc.piUid,
            order.piAmount,
            order._id as mongoose.Types.ObjectId,
            releaseResult.txid,
          );

          await User.findByIdAndUpdate(order.buyer,  { $inc: { totalTrades: 1, completedTrades: 1 } }, { session: dbSession });
          await User.findByIdAndUpdate(order.seller, { $inc: { totalTrades: 1, completedTrades: 1 } }, { session: dbSession });
          if (ad) await Ad.findByIdAndUpdate(ad._id, { $inc: { completedOrders: 1 } }, { session: dbSession });

          await dbSession.commitTransaction();

          await freshOrder.populate(POPULATE_ORDER);
          logger.info(`Order ${order._id} completed — txid=${releaseResult.txid}`);
          res.json({ success: true, order: freshOrder });
        } catch (dbErr) {
          await dbSession.abortTransaction();
          logger.error('release_escrow: DB update failed after successful on-chain transfer', dbErr);
          logger.error(`CRITICAL: Order ${order._id} Pi sent (txid=${releaseResult.txid ?? 'unknown'}) but DB not updated. Manual fix required.`);
          res.status(500).json({
            success: false,
            message: 'Pi was sent on-chain but the order record could not be updated. Please contact support with your order ID.',
            txid:    releaseResult.txid,
          });
        } finally {
          dbSession.endSession();
        }
        return;
      }

      // ── cancel ──────────────────────────────────────────────────────────
      //
      // Cancellation rules:
      //   • Cannot cancel a completed or disputed order (either party).
      //   • Cannot cancel once the buyer has confirmed payment (payment_sent):
      //       - Buyer:  already confirmed — must raise a dispute instead.
      //       - Seller: cannot cancel after payment confirmed — protects the buyer
      //                 from a seller vanishing after receiving fiat. Must dispute.
      //   • Otherwise (paymentPending): either party may cancel.
      //
      // Escrow refund on cancel:
      //   The locked Pi (order.escrow.piAmount) must be returned from the
      //   seller's lockedBalance back to piBalance so they can reuse the funds.
      //   This is handled by refundEscrow(), which is the correct service call
      //   for reversing a lockForEscrow() / reserveForAd() operation.
      //   The ad's availableAmount and reservedPi are also restored so the ad
      //   can continue serving new orders (or be accurately shown as available).
      case 'cancel': {
        // ── Terminal / irrevocable states ──────────────────────────────────
        if (
          order.status === OrderStatusEnum.completed ||
          order.status === OrderStatusEnum.disputed
        ) {
          await session.abortTransaction();
          res.status(400).json({
            success: false,
            message: order.status === OrderStatusEnum.completed
              ? 'Cannot cancel a completed order.'
              : 'Cannot cancel a disputed order. An admin is reviewing it.',
          });
          return;
        }

        // ── Block both parties once payment is confirmed ───────────────────
        // BUG FIX: previously only blocked the buyer; the seller could still
        // cancel after the buyer confirmed payment, potentially stealing fiat.
        if (order.status === OrderStatusEnum.paymentSent) {
          await session.abortTransaction();
          if (isBuyer) {
            res.status(400).json({
              success: false,
              message: 'You have already confirmed payment. Raise a dispute if there is an issue.',
            });
          } else {
            // isSeller
            res.status(400).json({
              success: false,
              message: 'You cannot cancel after the buyer has confirmed payment. Raise a dispute if you have not received the funds.',
            });
          }
          return;
        }

        // ── Safe to cancel — only paymentPending reaches here ─────────────
        order.status       = OrderStatusEnum.cancelled;
        order.cancelledAt  = new Date();
        order.cancelReason = reason;

        // Only mark escrow as refunded if it was actually locked.
        // (Guards against double-refund if somehow cancel is called twice.)
        if (order.escrow.status === EscrowStatusEnum.locked) {
          order.escrow.status = EscrowStatusEnum.refunded;
        }

        systemMsg = `Order cancelled.${reason ? ` Reason: ${reason}` : ''}`;

        // ── Restore ad available pool ──────────────────────────────────────
        // Return the Pi back so the ad can fill new orders.
        if (ad) {
          ad.availableAmount += order.piAmount;
          // Keep reservedPi in sync for sell ads (it tracks locked Pi on the ad).
          if (ad.type === AdTypeEnum.sell) {
            ad.reservedPi = (ad.reservedPi ?? 0) + order.piAmount;
          }
          // Re-activate the ad if it had been auto-completed by this order depleting it.
          if (ad.status === AdStatusEnum.completed) {
            ad.status = AdStatusEnum.active;
          }
          await ad.save({ session });
        }

        // ── Refund escrow back to seller's piBalance ───────────────────────
        // BUG FIX: this call was present before but didn't function correctly
        // because refundEscrow is designed to reverse a lockForEscrow() call —
        // moving piAmount from lockedBalance back to piBalance for the seller.
        //
        // For sell-ad orders: seller's lockedBalance was decremented when
        //   lockForEscrow() ran at order creation. refundEscrow() reverses that.
        //
        // For buy-ad orders: the incoming Pi-seller's lockedBalance was
        //   decremented via reserveForAd() at order creation. refundEscrow()
        //   equally reverses that, returning funds to their piBalance.
        //
        // sellerDoc._id always refers to the Pi holder (the party whose
        // balance was locked), so this is correct for both ad types.
        await refundOrderReservation(
          session,
          sellerDoc._id,
          sellerDoc.piUid,
          order.piAmount,
          order._id as mongoose.Types.ObjectId,
        );

        break;
      }

      // ── dispute ─────────────────────────────────────────────────────────
      case 'dispute':
        if (![OrderStatusEnum.paymentPending, OrderStatusEnum.paymentSent].includes(order.status)) {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'Cannot dispute this order in its current state' });
          return;
        }
        order.status        = OrderStatusEnum.disputed;
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
        type:      MessageTypeEnum.system,
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
    try { session.endSession(); } catch (_) { /* already ended */ }
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
      toId(order.buyer)  === userId ||
      toId(order.seller) === userId;
    if (!isParticipant) { res.status(403).json({ success: false, message: 'Unauthorized' }); return; }

    if ([OrderStatusEnum.completed, OrderStatusEnum.cancelled].includes(order.status)) {
      res.status(400).json({ success: false, message: 'Cannot send messages on a closed order' });
      return;
    }

    order.messages.push({
      sender:    new mongoose.Types.ObjectId(userId),
      content,
      type:      (type as MessageTypeEnum) || MessageTypeEnum.text,
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