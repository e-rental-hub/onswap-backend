import mongoose, { Document, Schema, Types } from 'mongoose';

export type AdType   = 'buy' | 'sell';
export type AdStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type PaymentMethod = 'bank_transfer' | 'opay' | 'palmpay' | 'kuda' | 'moniepoint';

export interface IPaymentMethodDetail {
  type:          PaymentMethod;
  label:         string;
  accountName?:  string;
  accountNumber?: string;
  bankName?:     string;
}

export interface IAd extends Document<Types.ObjectId> {
  creator:         Types.ObjectId;
  type:            AdType;
  piAmount:        number;
  availableAmount: number;
  minLimit:        number;
  maxLimit:        number;
  pricePerPi:      number;
  currency:        string;
  paymentMethods:  PaymentMethod[];
  paymentDetails:  IPaymentMethodDetail[];
  paymentWindow:   number;
  terms?:          string;
  autoReply?:      string;
  status:          AdStatus;
  completedOrders: number;
  /**
   * For sell ads: amount of seller's in-app piBalance reserved when this
   * ad was created. Prevents the seller from spending the same Pi twice.
   * 0 for buy ads.
   */
  reservedPi:      number;
  /** Snapshot of buyer's Pi wallet for buy ads — stored so counterparty can see it */
  piWalletAddress?: { address: string; tag: string };
  createdAt:       Date;
  updatedAt:       Date;
}

const PaymentMethodDetailSchema = new Schema<IPaymentMethodDetail>({
  type:          { type: String, required: true },
  label:         { type: String, required: true },
  accountName:   String,
  accountNumber: String,
  bankName:      String,
});

const AdSchema = new Schema<IAd>(
  {
    creator:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type:       { type: String, enum: ['buy', 'sell'], required: true },
    piAmount:        { type: Number, required: true, min: 1 },
    availableAmount: { type: Number, required: true },
    minLimit:        { type: Number, required: true, min: 1 },
    maxLimit:        { type: Number, required: true },
    pricePerPi:      { type: Number, required: true, min: 0 },
    currency:        { type: String, default: 'NGN' },
    paymentMethods:  [{ type: String, enum: ['bank_transfer', 'opay', 'palmpay', 'kuda', 'moniepoint'] }],
    paymentDetails:  [PaymentMethodDetailSchema],
    paymentWindow:   { type: Number, default: 15, min: 5, max: 120 },
    terms:           { type: String, maxlength: 500 },
    autoReply:       { type: String, maxlength: 300 },
    status:          { type: String, enum: ['active', 'paused', 'completed', 'cancelled'], default: 'active' },
    completedOrders: { type: Number, default: 0 },
    reservedPi:      { type: Number, default: 0, min: 0 },
    piWalletAddress: {
      type: new Schema({ address: { type: String, trim: true }, tag: { type: String, trim: true } }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true }
);

AdSchema.index({ type: 1, status: 1, currency: 1 });
AdSchema.index({ creator: 1 });

export const Ad = mongoose.model<IAd>('Ad', AdSchema);