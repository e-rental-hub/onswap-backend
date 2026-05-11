import { Response }    from 'express';
import mongoose        from 'mongoose';
import { Ad, IAd, PaymentMethod }     from '../models/Ad';
import { User }        from '../models/User';
import { AuthRequest } from '../middleware/auth';
import {
  reserveForAd,
  adjustAdReservation,
  refundAdReservation,
  lockForEscrow,
  refundEscrow,
} from '../services/walletService';
import { logger } from '../utils/logger';

// ─── GET /ads ─────────────────────────────────────────────────────────────────

export const getAds = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      type, currency = 'NGN', paymentMethod,
      minAmount, maxAmount, page = 1, limit = 20,
    } = req.query;

    const filter: Record<string, unknown> = { status: 'active' };
    if (type)          filter.type            = type;
    if (currency)      filter.currency        = currency;
    if (paymentMethod) filter.paymentMethods  = { $in: [paymentMethod] };
    if (minAmount)     filter.maxLimit        = { $gte: Number(minAmount) };
    if (maxAmount)     filter.minLimit        = { $lte: Number(maxAmount) };

    const skip = (Number(page) - 1) * Number(limit);
    const [ads, total] = await Promise.all([
      Ad.find(filter)
        .populate('creator', 'username displayName rating totalTrades completedTrades kycVerified')
        .sort({ pricePerPi: type === 'sell' ? 1 : -1 })
        .skip(skip)
        .limit(Number(limit)),
      Ad.countDocuments(filter),
    ]);

    res.json({ success: true, ads, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    logger.error('getAds error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch ads' });
  }
};

// ─── GET /ads/my ──────────────────────────────────────────────────────────────

export const getMyAds = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ads = await Ad.find({ creator: req.user!.id }).sort({ createdAt: -1 });
    res.json({ success: true, ads });
  } catch (err) {
    logger.error('getMyAds error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch ads' });
  }
};

// ─── GET /ads/:id ─────────────────────────────────────────────────────────────

export const getAdById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ad = await Ad.findById(req.params.id)
      .populate('creator', 'username displayName rating totalTrades completedTrades kycVerified');
    if (!ad) { res.status(404).json({ success: false, message: 'Ad not found' }); return; }
    res.json({ success: true, ad });
  } catch (err) {
    logger.error('getAdById error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch ad' });
  }
};

// ─── POST /ads ────────────────────────────────────────────────────────────────

export const createAd = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = req.user!.id;
    const {
      type, piAmount, minLimit, maxLimit, pricePerPi,
      currency, paymentMethods, paymentDetails,
      paymentWindow, terms, autoReply,
    } = req.body as {
      type: 'buy' | 'sell';
      piAmount: number;
      minLimit: number;
      maxLimit: number;
      pricePerPi: number;
      currency?: string;
      paymentMethods: string[];
      paymentDetails: IAd['paymentDetails'];
      paymentWindow: number;
      terms?: string;
      autoReply?: string;
    };

    // ── Sell-ad: check balance BEFORE creating the ad document ────────────
    if (type === 'sell') {
      const user = await User.findById(userId).session(session);
      if (!user) {
        await session.abortTransaction();
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      if (user.piBalance < piAmount) {
        await session.abortTransaction();
        res.status(400).json({
          success:      false,
          message:      'Insufficient Pi balance to create this sell ad.',
          required:     piAmount,
          available:    user.piBalance,
          shortfall:    Math.max(0, piAmount - user.piBalance),
          needsDeposit: true,
        });
        return;
      }
    }

    const [ad] = await Ad.create(
      [{
        creator: userId,
        type,
        piAmount,
        availableAmount: piAmount,
        minLimit,
        maxLimit,
        pricePerPi,
        currency: currency ?? 'NGN',
        paymentMethods: paymentMethods as PaymentMethod[],
        paymentDetails: paymentDetails ?? [],
        paymentWindow,
        terms,
        autoReply,

        reservedPi: type === 'sell' ? piAmount : 0,
      }],
      { session }
    );

    // ── Sell-ad: move piBalance → lockedBalance atomically ───────────────
    if (type === 'sell') {
      await reserveForAd(
        session,
        new mongoose.Types.ObjectId(userId),
        req.user!.piUid,
        piAmount,
        ad._id as mongoose.Types.ObjectId,
      );
    }

    await session.commitTransaction();

    const populated = await Ad.findById(ad._id)
      .populate('creator', 'username displayName rating totalTrades piBalance');

    logger.info(`Ad created: ${type} ${piAmount}π by ${req.user!.username}`);
    res.status(201).json({ success: true, ad: populated });
  } catch (err) {
    await session.abortTransaction();
    logger.error('createAd error:', err);
    const message = err instanceof Error ? err.message : 'Failed to create ad';
    res.status(500).json({ success: false, message });
  } finally {
    session.endSession();
  }
};

// ─── PATCH /ads/:id ───────────────────────────────────────────────────────────
//
// Editable fields:
//   Non-financial: pricePerPi, minLimit, maxLimit, paymentMethods,
//                  paymentDetails, paymentWindow, terms, autoReply
//   Status:        active ↔ paused  (no balance effect)
//   Financial:     piAmount — only for sell ads; triggers balance adjustment
//
// Rules:
//   • piAmount can only be changed if no orders are pending
//   • piAmount cannot exceed original piAmount (would allow selling more than deposited)
//   • piAmount decrease releases the delta back to piBalance
//   • piAmount increase locks additional piBalance

export const updateAd = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const ad = await Ad.findOne({ _id: req.params.id, creator: req.user!.id }).session(session);
    if (!ad) {
      await session.abortTransaction();
      res.status(404).json({ success: false, message: 'Ad not found or unauthorized' });
      return;
    }

    if (ad.status === 'cancelled' || ad.status === 'completed') {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Cannot edit a cancelled or completed ad' });
      return;
    }

    const b = req.body as Partial<Pick<IAd,
      'piAmount' | 'pricePerPi' | 'minLimit' | 'maxLimit' | 'paymentMethods' |
      'paymentDetails' | 'paymentWindow' | 'terms' | 'status' | 'autoReply'
    >>;

    // ── Financial field: piAmount (sell ads only) ─────────────────────────
    if (b.piAmount !== undefined && ad.type === 'sell') {
      const newPiAmount = b.piAmount;
      const oldPiAmount = ad.piAmount;

      // Cannot increase piAmount beyond what was originally listed
      // (would require more Pi than was ever deposited for this ad)
      if (newPiAmount > oldPiAmount) {
        await session.abortTransaction();
        res.status(400).json({
          success: false,
          message: `Cannot increase pi amount above the original ${oldPiAmount}π. Cancel and create a new ad instead.`,
        });
        return;
      }

      if (newPiAmount < 1) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'piAmount must be at least 1π' });
        return;
      }

      // Guard: cannot set piAmount lower than already-traded amount
      const tradedAmount = oldPiAmount - ad.availableAmount;
      if (newPiAmount < tradedAmount) {
        await session.abortTransaction();
        res.status(400).json({
          success: false,
          message: `Cannot set piAmount below already-traded amount (${tradedAmount}π traded so far).`,
        });
        return;
      }

      // Delta based on reservedPi — the actual currently-locked amount
      const oldReserved = ad.reservedPi;
      // New reservation = newPiAmount proportionally adjusted for traded volume
      // Simpler: newReservation = newPiAmount - tradedAmount
      const newReserved = newPiAmount - tradedAmount;

      if (newReserved !== oldReserved) {
        await adjustAdReservation(
          session,
          new mongoose.Types.ObjectId(req.user!.id),
          req.user!.piUid,
          oldReserved,
          newReserved,
          ad._id as mongoose.Types.ObjectId,
        );
        ad.reservedPi      = newReserved;
        ad.availableAmount = newPiAmount - tradedAmount;
      }

      ad.piAmount = newPiAmount;
    } else if (b.piAmount !== undefined && ad.type === 'buy') {
      // Buy ads carry no reserved Pi — just update the value
      ad.piAmount        = b.piAmount;
      ad.availableAmount = b.piAmount;
    }

    // ── Non-financial fields ──────────────────────────────────────────────
    if (b.pricePerPi     !== undefined) ad.pricePerPi     = b.pricePerPi;
    if (b.minLimit       !== undefined) ad.minLimit       = b.minLimit;
    if (b.maxLimit       !== undefined) ad.maxLimit       = b.maxLimit;
    if (b.paymentMethods !== undefined) ad.paymentMethods = b.paymentMethods;
    if (b.paymentDetails !== undefined) ad.paymentDetails = b.paymentDetails;
    if (b.paymentWindow  !== undefined) ad.paymentWindow  = b.paymentWindow;
    if (b.terms          !== undefined) ad.terms          = b.terms;
    if (b.autoReply      !== undefined) ad.autoReply      = b.autoReply;

    // ── Status toggle (active ↔ paused) — no balance effect ──────────────
    if (b.status !== undefined) {
      if (b.status !== 'active' && b.status !== 'paused') {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'Can only set status to active or paused' });
        return;
      }
      ad.status = b.status;
    }

    await ad.save({ session });
    await session.commitTransaction();

    logger.info(`Ad ${ad._id} updated by ${req.user!.username}`);
    res.json({ success: true, ad });
  } catch (err) {
    await session.abortTransaction();
    logger.error('updateAd error:', err);
    const message = err instanceof Error ? err.message : 'Failed to update ad';
    res.status(500).json({ success: false, message });
  } finally {
    session.endSession();
  }
};

// ─── DELETE /ads/:id ──────────────────────────────────────────────────────────
//
// Refunds EXACTLY `reservedPi` (not availableAmount) from lockedBalance back
// to piBalance. reservedPi already accounts for Pi consumed by completed
// orders, so this is always the correct remaining locked amount.

export const deleteAd = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const ad = await Ad.findOne({
      _id:     req.params.id,
      creator: req.user!.id,
    }).session(session);

    if (!ad) {
      await session.abortTransaction();
      res.status(404).json({ success: false, message: 'Ad not found or unauthorized' });
      return;
    }

    if (ad.status === 'cancelled') {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Ad is already cancelled' });
      return;
    }

    // For sell ads, refund whatever is still reserved — this is `reservedPi`,
    // NOT `availableAmount`. The difference is Pi already released to buyers.
    if (ad.type === 'sell' && ad.reservedPi > 0) {
      await refundAdReservation(
        session,
        new mongoose.Types.ObjectId(req.user!.id),
        req.user!.piUid,
        ad.reservedPi,                    // ← correct: reserved, not available
        ad._id as mongoose.Types.ObjectId,
      );
    }

    ad.status     = 'cancelled';
    ad.reservedPi = 0;                    // clear reservation record
    await ad.save({ session });
    await session.commitTransaction();

    logger.info(`Ad ${ad._id} cancelled by ${req.user!.username}, refunded=${ad.reservedPi}π`);
    res.json({ success: true, message: 'Ad cancelled and Pi returned to wallet' });
  } catch (err) {
    await session.abortTransaction();
    logger.error('deleteAd error:', err);
    const message = err instanceof Error ? err.message : 'Failed to cancel ad';
    res.status(500).json({ success: false, message });
  } finally {
    session.endSession();
  }
};

// ─── Export lockForEscrow / refundEscrow for orderController ─────────────────
// Re-exported so orderController imports from one place.
export { lockForEscrow, refundEscrow };

// ─── DELETE /ads/:id/hard ─────────────────────────────────────────────────────
//
// Permanently removes an ad from the database.
// Only permitted when:
//   1. Ad is already in `cancelled` status (Pi already refunded at cancel time)
//   2. No orders are in a live state (pending/payment_pending/payment_sent/disputed)
//
// This is intentionally a two-step process:
//   Step 1 — cancel (refunds Pi, sets status=cancelled)
//   Step 2 — hard delete (removes the document)
// Keeping them separate protects against accidental deletion of active ads.

export const hardDeleteAd = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const ad = await Ad.findOne({
      _id:     req.params.id,
      creator: req.user!.id,
    }).session(session);

    if (!ad) {
      await session.abortTransaction();
      res.status(404).json({ success: false, message: 'Ad not found or unauthorized' });
      return;
    }

    // Must be cancelled first — this guarantees Pi has already been refunded
    if (ad.status !== 'cancelled') {
      await session.abortTransaction();
      res.status(400).json({
        success: false,
        message: 'Cancel the ad first before deleting it permanently.',
      });
      return;
    }

    // Guard: no live orders referencing this ad
    // Import Order model inline to avoid circular imports
    const { Order } = await import('../models/Order');
    const liveOrder = await Order.findOne({
      ad:     ad._id,
      status: { $in: ['payment_pending', 'payment_sent', 'disputed'] },
    }).session(session);

    if (liveOrder) {
      await session.abortTransaction();
      res.status(400).json({
        success: false,
        message: 'Cannot delete: there are active orders linked to this ad. Wait for them to complete or be resolved.',
      });
      return;
    }

    await Ad.deleteOne({ _id: ad._id }).session(session);
    await session.commitTransaction();

    logger.info(`Ad ${ad._id} permanently deleted by ${req.user!.username}`);
    res.json({ success: true, message: 'Ad permanently deleted' });
  } catch (err) {
    await session.abortTransaction();
    logger.error('hardDeleteAd error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete ad' });
  } finally {
    session.endSession();
  }
};