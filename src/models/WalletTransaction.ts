import mongoose, { Document, Schema, Types } from 'mongoose';

export type TxType =
  | 'deposit'          // Pi payment from user wallet → app wallet (increases piBalance)
  | 'deposit_charge'   // Platform fee deducted from deposit
  | 'escrow_lock'      // piBalance → lockedBalance when sell-ad order opens
  | 'escrow_release'   // lockedBalance → 0, Pi sent to buyer on trade completion
  | 'escrow_refund'    // lockedBalance → piBalance when order cancelled/expired
  | 'withdraw';        // Future: app wallet → user Pi wallet (A2U)

export type TxStatus = 'pending' | 'confirmed' | 'failed';

export interface IWalletTransaction extends Document<Types.ObjectId> {
  userUid:      string;             // piUid of the user
  userId:       Types.ObjectId;     // ref User._id
  type:         TxType;
  amount:       number;             // Pi amount (always positive)
  fee:          number;             // Platform charge (Pi), 0 if none
  netAmount:    number;             // amount - fee (what actually lands)
  balanceBefore: number;
  balanceAfter:  number;
  status:       TxStatus;

  // Pi Platform references
  piPaymentId?: string;             // Pi payment identifier
  piTxId?:      string;             // on-chain txid

  // Internal references
  orderId?:     Types.ObjectId;     // linked P2P order (for escrow ops)
  adId?:        Types.ObjectId;     // linked ad

  memo:         string;
  createdAt:    Date;
  updatedAt:    Date;
}

const WalletTransactionSchema = new Schema<IWalletTransaction>(
  {
    userUid:  { type: String, required: true, index: true },
    userId:   { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type:     {
      type: String,
      enum: ['deposit', 'deposit_charge', 'escrow_lock', 'escrow_release', 'escrow_refund', 'withdraw'],
      required: true,
    },
    amount:        { type: Number, required: true, min: 0 },
    fee:           { type: Number, default: 0, min: 0 },
    netAmount:     { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter:  { type: Number, required: true },
    status:        { type: String, enum: ['pending', 'confirmed', 'failed'], default: 'pending' },

    piPaymentId: { type: String },
    piTxId:      { type: String, index: true, sparse: true },

    orderId: { type: Schema.Types.ObjectId, ref: 'Order', sparse: true },
    adId:    { type: Schema.Types.ObjectId, ref: 'Ad',    sparse: true },

    memo: { type: String, default: '' },
  },
  { timestamps: true }
);

WalletTransactionSchema.index({ userId: 1, createdAt: -1 });
WalletTransactionSchema.index({ piPaymentId: 1 }, { unique: true, sparse: true });

export const WalletTransaction = mongoose.model<IWalletTransaction>(
  'WalletTransaction',
  WalletTransactionSchema
);
