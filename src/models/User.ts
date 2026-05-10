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

// ─── Pi Wallet Address ───────────────────────────────────────────────────────

/**
 * A saved Pi (Stellar) wallet address with a user-assigned tag.
 * Mirrors IPaymentMethodDetail so the frontend uses the same
 * pick-from-list / add-new UX for both Naira accounts and Pi wallets.
 */
export interface IPiWalletAddress {
  _id:       Types.ObjectId;
  /** G… Stellar public key, exactly 56 chars */
  address:   string;
  /** User-assigned label, e.g. "My Pi Wallet", "Trading wallet" */
  tag:       string;
  isDefault: boolean;
  createdAt: Date;
}

export type IPiWalletAddressDoc = IPiWalletAddress & Types.Subdocument;

const PiWalletAddressSchema = new Schema<IPiWalletAddressDoc>(
  {
    address: {
      type:      String,
      required:  true,
      trim:      true,
      minlength: 56,
      maxlength: 56,
      match:     [/^G[A-Z2-7]{55}$/, 'Invalid Pi wallet address'],
    },
    tag:       { type: String, required: true, trim: true, maxlength: 60 },
    isDefault: { type: Boolean, default: false },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: true }
);

// ─── User ─────────────────────────────────────────────────────────────────────

export interface IUser extends Document<Types.ObjectId> {
  piUid:         string;
  username:      string;
  accessToken:   string;
  displayName:   string;
  phone?:        string;
  /**
   * On-chain Stellar public key — captured from Pi /v2/me at login.
   * Used to send Pi directly to the user's wallet without a /v2/users lookup.
   */
  walletAddress?: string;

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
  /** Saved Pi wallet addresses (for receiving Pi from escrow release) */
  piWalletAddresses: Types.DocumentArray<IPiWalletAddressDoc>;

  createdAt: Date;
  updatedAt: Date;

  // Virtuals
  completionRate:   number;
  availableBalance: number; // piBalance (alias for clarity)
}

const UserSchema = new Schema<IUser>(
  {
    piUid:         { type: String, required: true, unique: true, index: true },
    username:      { type: String, required: true, trim: true },
    accessToken:   { type: String, required: true },
    displayName:   { type: String, required: true, trim: true, maxlength: 60 },
    phone:         { type: String, trim: true },
    walletAddress: { type: String, trim: true, sparse: true },

    piBalance:     { type: Number, default: 0, min: 0 },
    lockedBalance: { type: Number, default: 0, min: 0 },

    kycVerified:     { type: Boolean, default: false },
    rating:          { type: Number, default: 5.0, min: 0, max: 5 },
    totalTrades:     { type: Number, default: 0 },
    completedTrades: { type: Number, default: 0 },

    paymentMethods:    { type: [PaymentMethodDetailSchema], default: [] },
    piWalletAddresses: { type: [PiWalletAddressSchema],    default: [] },
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