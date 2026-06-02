import mongoose, { Document, Schema, Types } from 'mongoose';
import { CurrencyEnum, EscrowStatusEnum, MessageTypeEnum, OrderStatusEnum, PaymentMethodEnum } from './enum';
import { IAdSellerAccountDetail } from './Ad';

export interface IMessage {
  sender:    Types.ObjectId;
  content:   string;
  timestamp: Date;
  type:      MessageTypeEnum;
  imageUrl?: string;
}

export interface IEscrow {
  piAmount:    number;
  status:      EscrowStatusEnum;
  lockedAt?:   Date;
  releasedAt?: Date;
  txId?:       string;
}

export interface IOrder extends Document<Types.ObjectId> {
  ad:            Types.ObjectId;
  buyer:         Types.ObjectId;
  seller:        Types.ObjectId;
  piAmount:      number;
  nairaAmount:   number;            // renamed from currencyAmount — matches controller & domain language
  pricePerPi:    number;
  currency:      CurrencyEnum;
  paymentMethod: PaymentMethodEnum;
  status:        OrderStatusEnum;
  escrow:        IEscrow;
  /**
   * Snapshot of the seller's payment account at order creation time.
   * Stored so the buyer knows where to send Naira even if the seller
   * later edits or removes the account from their profile.
   */
  sellerAccountDetail: IAdSellerAccountDetail;
  /**
   * Buyer's Stellar public key, resolved at order creation.
   * Used by the seller to release Pi via A2U transfer.
   */
  buyerWalletAddress:  string;
  messages:      IMessage[];
  paymentDeadline?: Date;
  completedAt?:  Date;
  cancelledAt?:  Date;
  cancelReason?:   string;
  disputeReason?:  string;
  createdAt:     Date;
  updatedAt:     Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    sender:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content:   { type: String, required: true },
    timestamp: { type: Date, default: () => new Date() },
    type:      { type: String, enum: MessageTypeEnum, default: MessageTypeEnum.text },
    imageUrl:  String,
  },
  { _id: false }
);

const EscrowSchema = new Schema<IEscrow>(
  {
    piAmount:   { type: Number, required: true },
    status:     { type: String, enum: EscrowStatusEnum, default: EscrowStatusEnum.pending },
    lockedAt:   Date,
    releasedAt: Date,
    txId:       String,
  },
  { _id: false }
);

// Reuse the same shape as IAdSellerAccountDetail — inline schema so the
// Order collection is self-contained (no cross-collection $lookup needed).
const SellerAccountDetailSchema = new Schema<IAdSellerAccountDetail>(
  {
    type:          { type: String, enum: PaymentMethodEnum, required: true },
    label:         { type: String, required: true, trim: true, maxlength: 60 },
    accountName:   { type: String, required: true, trim: true, maxlength: 80 },
    accountNumber: { type: String, required: true, trim: true, maxlength: 20 },
    bankName:      { type: String, trim: true, maxlength: 80 },
  },
  { _id: false }
);

const OrderSchema = new Schema<IOrder>(
  {
    ad:     { type: Schema.Types.ObjectId, ref: 'Ad',   required: true },
    buyer:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    piAmount:    { type: Number, required: true, min: 0 },
    nairaAmount: { type: Number, required: true, min: 0 },
    pricePerPi:  { type: Number, required: true },
    currency:    { type: String, enum: CurrencyEnum, default: CurrencyEnum.NGN },

    paymentMethod: { type: String, enum: PaymentMethodEnum, required: true },

    status: {
      type:    String,
      enum:    OrderStatusEnum,
      default: OrderStatusEnum.paymentPending,
    },

    escrow:              { type: EscrowSchema, required: true },
    sellerAccountDetail: { type: SellerAccountDetailSchema, required: true },
    buyerWalletAddress:  { type: String, required: true, trim: true },

    messages:        { type: [MessageSchema], default: [] },
    paymentDeadline: Date,
    completedAt:     Date,
    cancelledAt:     Date,
    cancelReason:    String,
    disputeReason:   String,
  },
  { timestamps: true }
);

OrderSchema.index({ buyer:  1, status: 1 });
OrderSchema.index({ seller: 1, status: 1 });
OrderSchema.index({ ad: 1 });

export const Order = mongoose.model<IOrder>('Order', OrderSchema);