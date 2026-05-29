import { Response }    from 'express';
import mongoose        from 'mongoose';
import { IMessage, Order }       from '../models/Order';
import { Ad }          from '../models/Ad';
import { User }        from '../models/User';
import { AuthRequest } from '../middleware/auth';
import {
  lockForEscrow,
  releaseEscrow,
  refundEscrow,
  reserveForAd,
} from '../services/walletService';
import { logger }        from '../utils/logger';
import { releaseToUser } from '../services/piNetwork.service';
import { config }        from '../config';
import { AdStatusEnum, AdTypeEnum, EscrowStatusEnum, MessageTypeEnum, OrderStatusEnum, PaymentMethodEnum } from '../models/enum';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const POPULATE_ORDER = [
  { path: 'buyer',  select: 'username displayName rating totalTrades completedTrades kycVerified piBalance piUid' },
  { path: 'seller', select: 'username displayName rating totalTrades completedTrades kycVerified' },
  { path: 'ad',     select: 'type paymentDetails paymentWindow terms autoReply paymentMethods' },
];

/**
 * Extract a plain string ID from a field that may be either a raw ObjectId
 * (before populate) or a full populated Mongoose document (after populate).
 *
 * Problem: after .populate(), `order.buyer` is a User document. Calling
 * `.toString()` on a Document returns "[object Object]", not the ID string.
 * We must use `._id.toString()` on populated documents, but `.toString()`
 * on raw ObjectIds. This helper handles both cases uniformly.
 */
function toId(field: unknown): string {
  if (field == null) return '';
  if (typeof field === 'object' && '_id' in (field as object)) {
    return (field as { _id: { toString(): string } })._id.toString();
  }
  return String(field);
}

// ─── POST /orders ─────────────────────────────────────────────────────────────
//
// Both `sellerAccountDetailId` and `buyerWalletAddressId` are required.
// The backend resolves them to full snapshots so the order is self-contained.
//
// Sell-ad flow:
//   • sellerAccountDetail  → resolved from ad.sellerAccountDetail (snapshot on ad)
//   • buyerWalletAddress   → resolved from buyer's piWalletAddresses by id
//
// Buy-ad flow:
//   • sellerAccountDetail  → resolved from incoming user's userAccountDetails by id
//   • buyerWalletAddress   → resolved from ad.buyerWalletAddress (snapshot on ad)

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
    // Sell-ad: snapshot is already stored on the ad at creation time.
    // Buy-ad:  the incoming user (Pi seller) picks one of their saved accounts.
    let sellerAccountDetail: typeof ad.sellerAccountDetail;

    if (isSellAd) {
      // The ad already holds the seller's payment account snapshot.
      if (!ad.sellerAccountDetail) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'This sell ad has no payment account on record.' });
        return;
      }
      sellerAccountDetail = ad.sellerAccountDetail;
    } else {
      // Incoming user is the Pi seller — look up their saved account.
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
    // Buy-ad:  wallet address snapshot is already stored on the ad.
    // Sell-ad: the incoming user (Pi buyer) picks one of their saved wallets.
    let buyerWalletAddress: string;

    if (isSellAd) {
      // Incoming user is the Pi buyer — look up their saved wallet.
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
      // The ad already holds the buyer's Pi wallet snapshot.
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

    // ── Build initial messages (system + optional auto-reply) ─────────────
    // Both messages are included when constructing the order document so they
    // are saved atomically — no separate .save() call needed.
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

    // ── Create order ──────────────────────────────────────────────────────
    // Use `new Order({...}).save({ session })` instead of `Order.create([...], { session })`.
    // The array-overload of Model.create() has ambiguous TypeScript overloads when
    // a session option is passed as the second argument — the compiler cannot narrow
    // the return type and produces "no overload matches" / "Type 'never'" errors.
    // Constructing the document explicitly and calling .save() avoids this entirely.
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
      // Pi already in seller's lockedBalance from ad creation — audit only.
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

    // Fetch WITHOUT populate first so buyer/seller are still raw ObjectIds.
    // Calling .toString() on a populated Document returns "[object Object]",
    // not the ID — that is what caused the spurious 403.
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

    // Use toId() — these fields are populated so ._id must be used, not .toString() directly
    const isBuyer  = toId(order.buyer)  === userId;
    const isSeller = toId(order.seller) === userId;
    if (!isBuyer && !isSeller) {
      await session.abortTransaction();
      res.status(403).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const sellerId = order.seller as unknown as { _id: mongoose.Types.ObjectId; piUid: string };
    const ad       = await Ad.findById(order.ad).session(session);

    let systemMsg = '';

    switch (action) {

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

      case 'release_escrow': {
        if (!isSeller) { await session.abortTransaction(); res.status(403).json({ success: false, message: 'Only seller can release escrow' }); return; }
        if (order.status !== 'payment_sent') { await session.abortTransaction(); res.status(400).json({ success: false, message: 'Awaiting buyer payment confirmation first' }); return; }

        // Buyer's wallet address was captured at order creation — use it directly.
        // No API lookup needed; address was validated (Stellar G... format) at order time.
        const buyerWalletAddr = (order as unknown as { buyerWalletAddress?: string }).buyerWalletAddress;
        if (!buyerWalletAddr) {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'Buyer wallet address not on this order — cannot release Pi' });
          return;
        }

        // Abort the DB session before the on-chain call.
        // Stellar transactions cannot be rolled back, so we commit the DB
        // state separately once we know the transfer succeeded.
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

        // ── Update DB now that the on-chain transfer succeeded ──────────────
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

          // Release from seller's lockedBalance (Pi has left the app)
          await releaseEscrow(
            dbSession,
            sellerId._id,
            sellerId.piUid,
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
          // The Pi transfer succeeded but DB update failed. Log prominently for manual reconciliation.
          logger.error(`CRITICAL: Order ${order._id} Pi sent (txid=${releaseResult.txid ?? 'unknown'}) but DB not updated. Manual fix required.`);
          res.status(500).json({
            success: false,
            message: 'Pi was sent on-chain but the order record could not be updated. Please contact support with your order ID.',
            txid:    releaseResult.txid,
          });
        } finally {
          dbSession.endSession();
        }
        // Early return — response already sent above
        return;
      }

      case 'cancel':
        if (order.status === OrderStatusEnum.completed || order.status === OrderStatusEnum.disputed) {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'Cannot cancel a completed or disputed order' });
          return;
        }
        if (order.status === OrderStatusEnum.paymentSent && isBuyer) {
          await session.abortTransaction();
          res.status(400).json({ success: false, message: 'You have already confirmed payment. Raise a dispute if there is an issue.' });
          return;
        }

        order.status        = OrderStatusEnum.cancelled;
        order.cancelledAt   = new Date();
        order.cancelReason  = reason;
        order.escrow.status = EscrowStatusEnum.refunded;
        systemMsg = `Order cancelled.${reason ? ` Reason: ${reason}` : ''}`;

        // Refund Pi back to the ad's available pool
        if (ad) {
          ad.availableAmount += order.piAmount;
          if (ad.type === AdTypeEnum.sell) ad.reservedPi = ad.availableAmount;
          if (ad.status === AdStatusEnum.completed) ad.status = AdStatusEnum.active;
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
    // Guard: session may already be ended inside the release_escrow case
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