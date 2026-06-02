import mongoose, { Document, Schema, Types } from 'mongoose';
import { CurrencyEnum, PaymentMethodEnum } from './enum';

// ─── Payment Method ───────────────────────────────────────────────────────────

export interface IUserAccountDetail {
  _id: Types.ObjectId;
  type: PaymentMethodEnum;
  label: string;
  accountName: string;
  accountNumber: string;
  bankName?: string;
  isDefault: boolean;
  createdAt: Date;
}

export type IUserAccountDetailDoc = IUserAccountDetail & Types.Subdocument;

export const UserAccountDetailSchema = new Schema<IUserAccountDetailDoc>(
  {
    type: {
      type: String,
      enum: PaymentMethodEnum,
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
  displayName:   string;
  phone?:        string;

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

  userAccountDetails: Types.DocumentArray<IUserAccountDetailDoc>;
  /** Saved Pi wallet addresses (for receiving Pi from escrow release) */
  piWalletAddresses: Types.DocumentArray<IPiWalletAddressDoc>;
  preferredCurrency: CurrencyEnum;

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
    displayName:   { type: String, required: true, trim: true, maxlength: 60 },
    phone:         { type: String, trim: true },

    piBalance:     { type: Number, default: 0, min: 0 },
    lockedBalance: { type: Number, default: 0, min: 0 },

    kycVerified:     { type: Boolean, default: false },
    rating:          { type: Number, default: 5.0, min: 0, max: 5 },
    totalTrades:     { type: Number, default: 0 },
    completedTrades: { type: Number, default: 0 },

    userAccountDetails:    { type: [UserAccountDetailSchema], default: [] },
    piWalletAddresses: { type: [PiWalletAddressSchema],    default: [] },
    preferredCurrency:    { type: String, enum: CurrencyEnum, default: CurrencyEnum.NGN },
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