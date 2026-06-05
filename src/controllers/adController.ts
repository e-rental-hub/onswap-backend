import { Response }    from 'express';
import mongoose        from 'mongoose';
import { Ad, IAd, IAdSellerAccountDetail } from '../models/Ad';
import { Order }       from '../models/Order';
import { User }        from '../models/User';
import { AuthRequest } from '../middleware/auth';
import {
  reserveForAd,
  adjustAdReservation,
  refundAdReservation
} from '../services/walletService';
import { logger } from '../utils/logger';
import { AdStatusEnum, AdTypeEnum, CurrencyEnum, OrderStatusEnum, PaymentMethodEnum } from '../models/enum';

// ─── GET /ads ─────────────────────────────────────────────────────────────────

export const getAds = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      type, currency = CurrencyEnum.NGN, paymentMethod,
      minAmount, maxAmount, page = 1, limit = 20,
    } = req.query;

    const filter: Record<string, unknown> = { status: 'active' };
    if (type)          filter.type           = type;
    if (currency)      filter.currency       = currency;
    if (paymentMethod) filter.paymentMethods = { $in: [paymentMethod] };
    if (minAmount)     filter.maxLimit       = { $gte: Number(minAmount) };
    if (maxAmount)     filter.minLimit       = { $lte: Number(maxAmount) };

    // FIX: clamp pagination values so page=0 or limit=0 don't produce
    // broken queries (skip=-20 or .limit(0) which returns all documents).
    const pageNum  = Math.max(1, Number(page)  || 1);
    const limitNum = Math.max(1, Math.min(Number(limit) || 20, 100)); // cap at 100

    const skip = (pageNum - 1) * limitNum;
    const [ads, total] = await Promise.all([
      Ad.find(filter)
        .populate('creator', 'username displayName rating totalTrades completedTrades kycVerified')
        .sort({ pricePerPi: type === 'sell' ? 1 : -1 })
        .skip(skip)
        .limit(limitNum),
      Ad.countDocuments(filter),
    ]);

    res.json({ success: true, ads, total, page: pageNum, pages: Math.ceil(total / limitNum) });
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
//
// Sell ad: sellerAccountDetail is required — a payment account snapshot is
//   stored on the ad so orders can copy it without an extra User lookup.
//
// Buy ad: buyerPiWalletAddress is required — the buyer's Stellar public key
//   is stored on the ad so orders can copy it without an extra User lookup.

export const createAd = async (req: AuthRequest, res: Response): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = req.user!.id;
    const {
      type, piAmount, minLimit, maxLimit, pricePerPi,
      currency, paymentMethods, sellerAccountDetailId,
      buyerPiWalletId, paymentWindow, terms, autoReply,
    } = req.body as {
      type:                   AdTypeEnum;
      piAmount:               number;
      minLimit:               number;
      maxLimit:               number;
      pricePerPi:             number;
      currency?:              CurrencyEnum;
      paymentMethods:         PaymentMethodEnum[];
      sellerAccountDetailId?: string;
      buyerPiWalletId?:       string;
      paymentWindow:          number;
      terms?:                 string;
      autoReply?:             string;
    };

    const payload = req.body

    console.log('request: ', payload);

    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    let sellerAccountDetail: IAdSellerAccountDetail | undefined;
    let buyerPiWalletAddress: string | undefined;

    // ── Type-specific field validation ────────────────────────────────────
    if (type === AdTypeEnum.sell) {

      // Sell-ad: check balance BEFORE creating the ad document.
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

      if (!sellerAccountDetailId) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'Seller must select an account detail for a sell ad.' });
        return;
      }

      const savedAccount = user.userAccountDetails.id(sellerAccountDetailId);
      if (!savedAccount) {
        // FIX: was missing session.abortTransaction() before this response,
        // leaving the session open and the transaction uncommitted.
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'Seller account detail not found.' });
        return;
      }

      sellerAccountDetail = {
        type:          savedAccount.type,
        label:         savedAccount.label,
        accountName:   savedAccount.accountName,
        accountNumber: savedAccount.accountNumber,
        bankName:      savedAccount.bankName,
      };
    } else {
      // buy ad
      if (!buyerPiWalletId) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'Buyer must select a Pi wallet for a buy ad.' });
        return;
      }

      const savedUserWallet = user.piWalletAddresses.id(buyerPiWalletId);
      if (!savedUserWallet) {
        // FIX: was missing session.abortTransaction() before this response,
        // leaving the session open and the transaction uncommitted.
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'Buyer wallet not found.' });
        return;
      }

      buyerPiWalletAddress = savedUserWallet.address;
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
        currency:            currency ?? CurrencyEnum.NGN,
        paymentMethods:      paymentMethods as PaymentMethodEnum[],
        sellerAccountDetail: type === AdTypeEnum.sell ? sellerAccountDetail : undefined,
        buyerWalletAddress:  type === AdTypeEnum.buy  ? buyerPiWalletAddress : undefined,
        paymentWindow,
        terms,
        autoReply,
        reservedPi: type === AdTypeEnum.sell ? piAmount : 0,
      }],
      { session }
    );

    // Sell-ad: move piBalance → lockedBalance atomically.
    if (type === AdTypeEnum.sell) {
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
//   Financial:     piAmount — sell ads trigger balance adjustment;
//                             buy ads require traded-amount guard
//
// Rules:
//   • piAmount (sell): cannot exceed original piAmount; cannot go below
//     already-traded amount; decrease releases delta to piBalance.
//   • piAmount (buy):  no Pi is locked, but cannot go below already-traded
//     amount (would make availableAmount negative).
//   • minLimit/maxLimit: validated to stay consistent with each other.

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

    if (ad.status === AdStatusEnum.cancelled || ad.status === AdStatusEnum.completed) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Cannot edit a cancelled or completed ad' });
      return;
    }

    const b = req.body as Partial<Pick<IAd,
      'piAmount' | 'pricePerPi' | 'minLimit' | 'maxLimit' | 'paymentMethods' |
      'paymentDetails' | 'paymentWindow' | 'terms' | 'status' | 'autoReply'
    >>;

    // ── Resolve effective limit values for cross-field validation ─────────
    // Use incoming value when provided, otherwise fall back to the stored value.
    const effectiveMinLimit = b.minLimit  !== undefined ? b.minLimit  : ad.minLimit;
    const effectiveMaxLimit = b.maxLimit  !== undefined ? b.maxLimit  : ad.maxLimit;

    // ── Validation handled in /validate/updateAdSchema non-financial fields before any writes ───────────────────
    
    // FIX: validate the effective min/max pair so a partial update (only one
    // side supplied) cannot result in minLimit > maxLimit on the stored ad.
    if (effectiveMinLimit > effectiveMaxLimit) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'minLimit cannot be greater than maxLimit.' });
      return;
    }
    
    // ── Financial field: piAmount ──────────────────────────────────────────
    if (b.piAmount !== undefined) {
      const newPiAmount   = b.piAmount;
      const tradedAmount  = ad.piAmount - ad.availableAmount; // Pi already consumed by orders

      if (newPiAmount < 1) {
        await session.abortTransaction();
        res.status(400).json({ success: false, message: 'piAmount must be at least 1π.' });
        return;
      }

      // FIX: apply tradedAmount guard to both ad types.
      // Without this a buy-ad could have its piAmount set below the amount
      // already matched by orders, driving availableAmount negative.
      if (newPiAmount < tradedAmount) {
        await session.abortTransaction();
        res.status(400).json({
          success: false,
          message: `Cannot set piAmount below already-traded amount (${tradedAmount}π traded so far).`,
        });
        return;
      }

      if (ad.type === AdTypeEnum.sell) {
        // Sell-ad: piAmount increase is blocked — would require locking more Pi
        // from the user's balance which isn't collected here. User must cancel
        // and create a new ad with the larger amount.
        if (newPiAmount > ad.piAmount) {
          await session.abortTransaction();
          res.status(400).json({
            success: false,
            message: `Cannot increase pi amount above the original ${ad.piAmount}π. Cancel and create a new ad instead.`,
          });
          return;
        }

        // Delta based on reservedPi — the actual currently-locked amount.
        const oldReserved = ad.reservedPi;
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
      } else {
        // Buy-ad: no Pi is locked, so no wallet operation is needed.
        // FIX: derive availableAmount from the traded amount, not just the
        // raw newPiAmount. The old code did `availableAmount = b.piAmount`
        // which overstated availability if orders had already partially filled
        // the ad (e.g. 5π traded on a 10π ad → set piAmount=7 should give
        // availableAmount=2, not 7).
        ad.piAmount        = newPiAmount;
        ad.availableAmount = newPiAmount - tradedAmount;
      }
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
      if (b.status !== AdStatusEnum.active && b.status !== AdStatusEnum.paused) {
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
// Soft-cancel: sets status=cancelled and refunds EXACTLY `reservedPi`
// (not availableAmount) from lockedBalance back to piBalance. reservedPi
// already accounts for Pi consumed by completed orders.

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

    if (ad.status === AdStatusEnum.cancelled) {
      await session.abortTransaction();
      res.status(400).json({ success: false, message: 'Ad is already cancelled' });
      return;
    }

    const refundedAmount = ad.reservedPi;

    if (ad.type === AdTypeEnum.sell && ad.reservedPi > 0) {
      await refundAdReservation(
        session,
        new mongoose.Types.ObjectId(req.user!.id),
        req.user!.piUid,
        ad.reservedPi,
        ad._id as mongoose.Types.ObjectId,
      );
    }

    ad.status     = AdStatusEnum.cancelled;
    ad.reservedPi = 0;
    await ad.save({ session });
    await session.commitTransaction();

    logger.info(`Ad ${ad._id} cancelled by ${req.user!.username}, refunded=${refundedAmount}π`);
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

// ─── DELETE /ads/:id/hard ─────────────────────────────────────────────────────
//
// Permanently removes an ad from the database.
// Only permitted when:
//   1. Ad is already in `cancelled` status (Pi already refunded at cancel time)
//   2. No orders are in a live state (pending/payment_pending/payment_sent/disputed)
//
// FIX: Order is now imported at the top of the file (static import) rather than
// inside this function via a dynamic import(). The dynamic import would throw
// unhandled if module resolution failed, bypassing the outer try/catch.

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

    if (ad.status !== AdStatusEnum.cancelled) {
      await session.abortTransaction();
      res.status(400).json({
        success: false,
        message: 'Cancel the ad first before deleting it permanently.',
      });
      return;
    }

    // Guard: no live orders referencing this ad.
    // FIX: Order is now a static import at the top of the file.
    const liveOrder = await Order.findOne({
      ad:     ad._id,
      status: { $in: [OrderStatusEnum.paymentPending, OrderStatusEnum.paymentSent, OrderStatusEnum.disputed] },
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