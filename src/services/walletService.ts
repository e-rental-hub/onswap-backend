import mongoose, { ClientSession, Types } from 'mongoose';
import { User }                           from '../models/User';
import { WalletTransaction, TxType }      from '../models/WalletTransaction';
import { logger }                         from '../utils/logger';

// ─── Config ───────────────────────────────────────────────────────────────────

export const DEPOSIT_FEE_RATE = Number(process.env.DEPOSIT_FEE_RATE ?? 0.01); // 1 %
export const MIN_DEPOSIT_PI   = Number(process.env.MIN_DEPOSIT_PI   ?? 1);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreditResult {
  newBalance:    number;
  netAmount:     number;
  fee:           number;
  transactionId: string;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

async function recordTx(
  session: ClientSession,
  params: {
    userId:        Types.ObjectId;
    userUid:       string;
    type:          TxType;
    amount:        number;
    fee:           number;
    netAmount:     number;
    balanceBefore: number;
    balanceAfter:  number;
    status:        'pending' | 'confirmed' | 'failed';
    piPaymentId?:  string;
    piTxId?:       string;
    orderId?:      Types.ObjectId;
    adId?:         Types.ObjectId;
    memo:          string;
  }
) {
  const [tx] = await WalletTransaction.create([params], { session });
  return tx;
}

/** Round to 4 decimal places — consistent precision for all Pi amounts */
function r4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ─── Deposit ──────────────────────────────────────────────────────────────────

/**
 * Credit piBalance after a confirmed Pi U2A payment.
 * Idempotent: second call with the same piPaymentId is a no-op.
 */
export async function creditDeposit(
  userId:      Types.ObjectId,
  userUid:     string,
  grossAmount: number,
  piPaymentId: string,
  piTxId:      string,
  memo = 'Pi deposit'
): Promise<CreditResult> {
  // Idempotency guard — never double-credit the same Pi payment
  const existing = await WalletTransaction.findOne({
    piPaymentId,
    type:   'deposit',
    status: 'confirmed',
  });
  if (existing) {
    logger.warn(`[Wallet] Duplicate deposit ignored: ${piPaymentId}`);
    const user = await User.findById(userId).lean();
    return {
      newBalance:    user?.piBalance ?? 0,
      netAmount:     existing.netAmount,
      fee:           existing.fee,
      transactionId: existing._id.toString(),
    };
  }

  const fee       = r4(grossAmount * DEPOSIT_FEE_RATE);
  const netAmount = r4(grossAmount - fee);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');

    const balanceBefore = user.piBalance;
    const balanceAfter  = r4(balanceBefore + netAmount);
    user.piBalance      = balanceAfter;
    await user.save({ session });

    const tx = await recordTx(session, {
      userId: user._id, userUid, type: 'deposit',
      amount: grossAmount, fee, netAmount,
      balanceBefore, balanceAfter,
      status: 'confirmed', piPaymentId, piTxId, memo,
    });

    if (fee > 0) {
      await recordTx(session, {
        userId: user._id, userUid, type: 'deposit_charge',
        amount: fee, fee: 0, netAmount: fee,
        balanceBefore: balanceAfter, balanceAfter,
        status: 'confirmed', piPaymentId,
        memo: 'Deposit platform fee',
      });
    }

    await session.commitTransaction();
    logger.info(`[Wallet] Deposit: uid=${userUid} gross=${grossAmount}π fee=${fee}π net=${netAmount}π`);
    return { newBalance: balanceAfter, netAmount, fee, transactionId: tx._id.toString() };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

// ─── Ad reservation (sell-ad created) ────────────────────────────────────────

/**
 * Move `amount` from piBalance → lockedBalance when a SELL AD is posted.
 *
 * Distinct from lockForEscrow (which is for P2P orders) so the ledger
 * type ('ad_reserve') clearly identifies the source of the lock.
 * Uses adId as the primary reference — no orderId yet.
 */
export async function reserveForAd(
  session: ClientSession,
  userId:  Types.ObjectId,
  userUid: string,
  amount:  number,
  adId:    Types.ObjectId,
): Promise<void> {
  const user = await User.findById(userId).session(session);
  if (!user) throw new Error('User not found');

  if (r4(user.piBalance) < r4(amount)) {
    throw new Error(
      `Insufficient Pi balance. Available: ${user.piBalance}π, required: ${amount}π`
    );
  }

  const balanceBefore  = user.piBalance;
  user.piBalance       = r4(user.piBalance - amount);
  user.lockedBalance   = r4(user.lockedBalance + amount);
  await user.save({ session });

  await recordTx(session, {
    userId: user._id, userUid, type: 'escrow_lock',
    amount, fee: 0, netAmount: amount,
    balanceBefore, balanceAfter: user.piBalance,
    status: 'confirmed', adId,
    memo: `Pi reserved for sell ad ${adId}`,
  });

  logger.debug(`[Wallet] reserveForAd: uid=${userUid} amount=${amount}π adId=${adId}`);
}

/**
 * Adjust the ad reservation when the seller edits the piAmount on a sell ad.
 *
 * - newAmount > oldAmount  →  lock the delta  (must have enough piBalance)
 * - newAmount < oldAmount  →  unlock the delta back to piBalance
 * - newAmount === oldAmount → no-op
 */
export async function adjustAdReservation(
  session:   ClientSession,
  userId:    Types.ObjectId,
  userUid:   string,
  oldAmount: number,
  newAmount: number,
  adId:      Types.ObjectId,
): Promise<void> {
  const delta = r4(newAmount - oldAmount);
  if (delta === 0) return;

  const user = await User.findById(userId).session(session);
  if (!user) throw new Error('User not found');

  if (delta > 0) {
    // Need to lock MORE Pi
    if (r4(user.piBalance) < delta) {
      throw new Error(
        `Insufficient Pi balance to increase ad amount. ` +
        `Available: ${user.piBalance}π, extra required: ${delta}π`
      );
    }
    user.piBalance     = r4(user.piBalance     - delta);
    user.lockedBalance = r4(user.lockedBalance + delta);

    await recordTx(session, {
      userId: user._id, userUid, type: 'escrow_lock',
      amount: delta, fee: 0, netAmount: delta,
      balanceBefore: r4(user.piBalance + delta),
      balanceAfter:  user.piBalance,
      status: 'confirmed', adId,
      memo: `Ad reservation increased by ${delta}π for ad ${adId}`,
    });
  } else {
    // Release the excess back to piBalance
    const release = r4(Math.abs(delta));
    user.lockedBalance = r4(Math.max(0, user.lockedBalance - release));
    user.piBalance     = r4(user.piBalance + release);

    await recordTx(session, {
      userId: user._id, userUid, type: 'escrow_refund',
      amount: release, fee: 0, netAmount: release,
      balanceBefore: r4(user.piBalance - release),
      balanceAfter:  user.piBalance,
      status: 'confirmed', adId,
      memo: `Ad reservation decreased by ${release}π for ad ${adId}`,
    });
  }

  await user.save({ session });
  logger.debug(
    `[Wallet] adjustAdReservation: uid=${userUid} delta=${delta}π adId=${adId}`
  );
}

/**
 * Refund the REMAINING reserved Pi back to piBalance when a sell ad is
 * cancelled or fully exhausted.
 *
 * Uses `reservedAmount` (the original full reservation) minus what has
 * already been released via order escrow releases, NOT availableAmount —
 * to prevent double-counting when trades have partially filled the ad.
 */
export async function refundAdReservation(
  session:        ClientSession,
  userId:         Types.ObjectId,
  userUid:        string,
  remainingAmount: number,
  adId:           Types.ObjectId,
): Promise<void> {
  if (remainingAmount <= 0) return;

  const user = await User.findById(userId).session(session);
  if (!user) throw new Error('User not found');

  const balanceBefore  = user.piBalance;
  // Never let lockedBalance go negative — guard against accounting drift
  user.lockedBalance   = r4(Math.max(0, user.lockedBalance - remainingAmount));
  user.piBalance       = r4(user.piBalance + remainingAmount);
  await user.save({ session });

  await recordTx(session, {
    userId: user._id, userUid, type: 'escrow_refund',
    amount: remainingAmount, fee: 0, netAmount: remainingAmount,
    balanceBefore, balanceAfter: user.piBalance,
    status: 'confirmed', adId,
    memo: `Ad reservation refunded on cancel for ad ${adId}`,
  });

  logger.debug(
    `[Wallet] refundAdReservation: uid=${userUid} refunded=${remainingAmount}π adId=${adId}`
  );
}

// ─── Order escrow lock (P2P order opened against a sell ad) ──────────────────

/**
 * For sell-ad orders: the Pi is ALREADY in lockedBalance (reserved at ad
 * creation). An order simply records the commitment — no balance movement
 * needed. We write a ledger row for audit purposes only.
 *
 * This is intentionally a no-op on the numeric balances.
 */
export async function lockForEscrow(
  session: ClientSession,
  userId:  Types.ObjectId,
  userUid: string,
  amount:  number,
  orderId: Types.ObjectId,
  adId?:   Types.ObjectId,
): Promise<void> {
  const user = await User.findById(userId).session(session);
  if (!user) throw new Error('User not found');

  // Verify the locked balance can actually cover this order
  if (r4(user.lockedBalance) < r4(amount)) {
    throw new Error(
      `Locked balance insufficient for order escrow. ` +
      `Locked: ${user.lockedBalance}π, required: ${amount}π`
    );
  }

  // No balance movement — Pi was already moved to lockedBalance at ad creation.
  // Record for audit trail only.
  await recordTx(session, {
    userId: user._id, userUid, type: 'escrow_lock',
    amount, fee: 0, netAmount: amount,
    balanceBefore: user.piBalance, balanceAfter: user.piBalance,
    status: 'confirmed', orderId, adId,
    memo: `Order escrow committed for order ${orderId}`,
  });

  logger.debug(`[Wallet] lockForEscrow (audit): uid=${userUid} amount=${amount}π orderId=${orderId}`);
}

// ─── Escrow release (trade completed — Pi goes to buyer off-chain) ────────────

/**
 * Decrement lockedBalance once Pi has been sent to the buyer on-chain (A2U).
 * piBalance is NOT touched — the Pi leaves the app entirely.
 */
export async function releaseEscrow(
  session: ClientSession,
  userId:  Types.ObjectId,
  userUid: string,
  amount:  number,
  orderId: Types.ObjectId,
  piTxId?: string,
): Promise<void> {
  const user = await User.findById(userId).session(session);
  if (!user) throw new Error('User not found');

  const balanceBefore  = user.piBalance;
  user.lockedBalance   = r4(Math.max(0, user.lockedBalance - amount));
  await user.save({ session });

  await recordTx(session, {
    userId: user._id, userUid, type: 'escrow_release',
    amount, fee: 0, netAmount: amount,
    balanceBefore, balanceAfter: user.piBalance,
    status: 'confirmed', piTxId, orderId,
    memo: `Pi released to buyer for order ${orderId}`,
  });

  logger.debug(`[Wallet] releaseEscrow: uid=${userUid} amount=${amount}π orderId=${orderId}`);
}

// ─── Escrow refund (P2P order cancelled / expired) ────────────────────────────

/**
 * When a P2P order is cancelled BEFORE completion, return the Pi from
 * lockedBalance back to the ad's available pool.
 *
 * For sell ads: the Pi goes back to lockedBalance (still reserved for the ad,
 * just no longer committed to this specific order).
 * The ad's availableAmount is also restored in adController.
 *
 * No ledger entry needed here — the Pi never left lockedBalance for this order.
 * This is intentionally a no-op on balances; audit row written for completeness.
 */
export async function refundEscrow(
  session: ClientSession,
  userId:  Types.ObjectId,
  userUid: string,
  amount:  number,
  orderId: Types.ObjectId,
): Promise<void> {
  const user = await User.findById(userId).session(session);
  if (!user) throw new Error('User not found');

  // Pi stays in lockedBalance — just restore it to the ad pool (handled in orderController)
  await recordTx(session, {
    userId: user._id, userUid, type: 'escrow_refund',
    amount, fee: 0, netAmount: amount,
    balanceBefore: user.piBalance, balanceAfter: user.piBalance,
    status: 'confirmed', orderId,
    memo: `Order escrow released back to ad pool for order ${orderId}`,
  });

  logger.debug(`[Wallet] refundEscrow (audit): uid=${userUid} amount=${amount}π orderId=${orderId}`);
}

// ─── Balance query ────────────────────────────────────────────────────────────

export async function getWalletSummary(userId: Types.ObjectId) {
  const user = await User.findById(userId).select('piBalance lockedBalance').lean();
  return {
    piBalance:     user?.piBalance     ?? 0,
    lockedBalance: user?.lockedBalance ?? 0,
    totalHeld:     r4((user?.piBalance ?? 0) + (user?.lockedBalance ?? 0)),
  };
}