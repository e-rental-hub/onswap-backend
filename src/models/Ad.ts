import mongoose, { Document, Schema, Types } from 'mongoose';
import { AdStatusEnum, AdTypeEnum, CurrencyEnum, PaymentMethodEnum } from './enum';

// Defined inline (not imported from User) to keep the Ad document
// self-contained — User subdoc schema carries extra fields (_id, isDefault,
// createdAt) that are irrelevant once snapshotted onto an ad.
export interface IAdSellerAccountDetail {
  type:          PaymentMethodEnum;
  label:         string;
  accountName:   string;
  accountNumber: string;
  bankName?:     string;
}

export interface IAd extends Document<Types.ObjectId> {
  creator:             Types.ObjectId;
  type:                AdTypeEnum;
  piAmount:            number;
  availableAmount:     number;
  minLimit:            number;
  maxLimit:            number;
  pricePerPi:          number;
  currency:            string;
  paymentMethods:      PaymentMethodEnum[];
  /**
   * Required for sell ads: snapshot of the seller's Naira payment account.
   * Stored at ad creation so orders can copy it without a separate lookup.
   */
  sellerAccountDetail?: IAdSellerAccountDetail;
  /**
   * Required for buy ads: the ad creator's Pi wallet address.
   * Stored at ad creation so orders can copy it without a separate lookup.
   */
  buyerWalletAddress?: string;
  paymentWindow:       number;
  terms?:              string;
  autoReply?:          string;
  /**
   * Arbitrary extra payment instructions (e.g. reference notes).
   * Editable via PATCH /ads/:id.
   */
  paymentDetails?:     string;
  status:              AdStatusEnum;
  completedOrders:     number;
  /**
   * For sell ads: Pi locked from seller's piBalance when the ad was created.
   * Decremented as orders complete; refunded in full if the ad is cancelled.
   * Always 0 for buy ads.
   */
  reservedPi:          number;
  createdAt:           Date;
  updatedAt:           Date;
}

const AdSchema = new Schema<IAd>(
  {
    creator:         { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type:            { type: String, enum: AdTypeEnum, required: true },
    piAmount:        { type: Number, required: true, min: 1 },
    availableAmount: { type: Number, required: true },
    minLimit:        { type: Number, required: true, min: 1 },
    maxLimit:        { type: Number, required: true },
    pricePerPi:      { type: Number, required: true, min: 0 },
    currency:        { type: String, enum: CurrencyEnum, default: CurrencyEnum.NGN },
    paymentMethods:  [{ type: String, enum: PaymentMethodEnum }],

    sellerAccountDetail: {
      type: new Schema<IAdSellerAccountDetail>(
        {
          type:          { type: String, enum: PaymentMethodEnum, required: true },
          label:         { type: String, required: true, trim: true, maxlength: 60 },
          accountName:   { type: String, required: true, trim: true, maxlength: 80 },
          accountNumber: { type: String, required: true, trim: true, maxlength: 20 },
          bankName:      { type: String, trim: true, maxlength: 80 },
        },
        { _id: false }
      ),
      default: undefined,
    },

    buyerWalletAddress: { type: String, trim: true, default: undefined },
    paymentWindow:      { type: Number, default: 15, min: 5, max: 120 },
    terms:              { type: String, maxlength: 500 },
    autoReply:          { type: String, maxlength: 300 },
    paymentDetails:     { type: String, maxlength: 500 },
    status:             { type: String, enum: AdStatusEnum, default: AdStatusEnum.active },
    completedOrders:    { type: Number, default: 0 },
    reservedPi:         { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

AdSchema.index({ type: 1, status: 1, currency: 1 });
AdSchema.index({ creator: 1 });

export const Ad = mongoose.model<IAd>('Ad', AdSchema);