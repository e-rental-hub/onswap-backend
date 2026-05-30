import { MongoServerError } from 'mongodb';
import { Types } from 'mongoose';
import { CreditResult } from './types';
import { WalletTransaction } from './models/WalletTransaction';
import { User } from './models/User';

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isDuplicateKeyError(err: unknown, field: string): boolean {
  return (
    err instanceof MongoServerError &&
    err.code === 11000 &&
    Object.keys(err.keyPattern ?? {}).includes(field)
  );
}

export async function fetchExistingDepositResult(
  userId: Types.ObjectId,
  piPaymentId: string
): Promise<CreditResult> {
  const existing = await WalletTransaction.findOne({
    piPaymentId,
    type:   'deposit',
    status: 'confirmed',
  }).lean();

  if (!existing) throw new Error(`Deposit record missing after duplicate key: ${piPaymentId}`);

  const user = await User.findById(userId).lean();
  return {
    newBalance:    user?.piBalance ?? 0,
    netAmount:     existing.netAmount,
    fee:           existing.fee,
    transactionId: existing._id.toString(),
  };
}