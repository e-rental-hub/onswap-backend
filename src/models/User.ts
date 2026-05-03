import mongoose, { Document, Schema, Types } from 'mongoose';

// ─── Payment Method ───────────────────────────────────────────────────────────

export type PaymentMethodType =
  | 'bank_transfer'
  | 'opay'
  | 'palmpay'
  | 'kuda'
  | 'moniepoint';

export interface IPaymentMethodDetail {
  _id: Types.ObjectId;
  type: PaymentMethodType;
  label: string;
  accountName: string;
  accountNumber: string;
  bankName?: string;
  isDefault: boolean;
  createdAt: Date;
}

export type IPaymentMethodDetailDoc = IPaymentMethodDetail & Types.Subdocument;

const PaymentMethodDetailSchema = new Schema<IPaymentMethodDetailDoc>(
  {
    type: {
      type: String,
      enum: ['bank_transfer', 'opay', 'palmpay', 'kuda', 'moniepoint'],
      required: true,
    },
    label:         { type: String, required: true, trim: true, maxlength: 60 },
    accountName:   { type: String, required: true, trim: true, maxlength: 80 },
    accountNumber: { type: String, required: true, trim: true, maxlength: 20 },
    bankName:      { type: String, trim: true, maxlength: 80 },
    isDefault:     { type: Boolean, default: false },
    createdAt:     { type: Date, default: () => new Date() },
  },
  { _id: true }
);

// ─── User ─────────────────────────────────────────────────────────────────────

export interface IUser extends Document<Types.ObjectId> {
  piUid:        string;
  username:     string;
  accessToken:  string;
  displayName:  string;
  phone?:       string;

  // ── In-app wallet ──────────────────────────────────────────────────────────
  /**
   * Available Pi balance — deposited via Pi payments, decremented when a
   * sell ad locks Pi into escrow, incremented when escrow is refunded.
   */
  piBalance:     number;
  /**
   * Pi currently locked across active sell-ad escrows.
   * piBalance + lockedBalance = total Pi held by the app on behalf of this user.
   */
  lockedBalance: number;

  // ── Reputation ─────────────────────────────────────────────────────────────
  kycVerified:     boolean;
  rating:          number;
  totalTrades:     number;
  completedTrades: number;

  paymentMethods: Types.DocumentArray<IPaymentMethodDetailDoc>;

  createdAt: Date;
  updatedAt: Date;

  // Virtuals
  completionRate:   number;
  availableBalance: number; // piBalance (alias for clarity)
}

const UserSchema = new Schema<IUser>(
  {
    piUid:       { type: String, required: true, unique: true, index: true },
    username:    { type: String, required: true, trim: true },
    accessToken: { type: String, required: true },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    phone:       { type: String, trim: true },

    piBalance:     { type: Number, default: 0, min: 0 },
    lockedBalance: { type: Number, default: 0, min: 0 },

    kycVerified:     { type: Boolean, default: false },
    rating:          { type: Number, default: 5.0, min: 0, max: 5 },
    totalTrades:     { type: Number, default: 0 },
    completedTrades: { type: Number, default: 0 },

    paymentMethods: { type: [PaymentMethodDetailSchema], default: [] },
  },
  { timestamps: true }
);

UserSchema.virtual('completionRate').get(function (this: IUser) {
  if (this.totalTrades === 0) return 100;
  return Math.round((this.completedTrades / this.totalTrades) * 100);
});

UserSchema.virtual('availableBalance').get(function (this: IUser) {
  return this.piBalance;
});

UserSchema.set('toJSON', { virtuals: true });

export const User = mongoose.model<IUser>('User', UserSchema);
