import mongoose, { Document, Schema, Types } from 'mongoose';

export type OrderStatus =
  | 'payment_pending'   // buyer needs to send Naira
  | 'payment_sent'      // buyer confirmed payment; seller to verify & release
  | 'completed'         // seller released Pi
  | 'disputed'          // either party raised a dispute
  | 'cancelled'         // cancelled before payment sent
  | 'refunded';         // Pi returned after dispute resolution

export interface IMessage {
  sender:    Types.ObjectId;
  content:   string;
  timestamp: Date;
  type:      'text' | 'system' | 'payment_proof';
  imageUrl?: string;
}

export interface IEscrow {
  piAmount:    number;
  status:      'pending' | 'locked' | 'released' | 'refunded';
  lockedAt?:   Date;
  releasedAt?: Date;
  txId?:       string;
}

export interface IOrder extends Document<Types.ObjectId> {
  ad:            Types.ObjectId;
  buyer:         Types.ObjectId;
  seller:        Types.ObjectId;
  piAmount:      number;
  nairaAmount:   number;
  pricePerPi:    number;
  currency:      string;
  paymentMethod: string;
  status:        OrderStatus;
  escrow:        IEscrow;
  messages:      IMessage[];
  paymentDeadline?: Date;
  completedAt?:  Date;
  cancelledAt?:  Date;
  cancelReason?:        string;
  disputeReason?:       string;
  /**
   * Buyer's on-chain Stellar public key — provided at order creation.
   * Used by the seller to release Pi via A2U transfer.
   */
  buyerWalletAddress:   string;
  createdAt:            Date;
  updatedAt:            Date;
}

const MessageSchema = new Schema<IMessage>({
  sender:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  content:   { type: String, required: true },
  timestamp: { type: Date, default: () => new Date() },
  type:      { type: String, enum: ['text', 'system', 'payment_proof'], default: 'text' },
  imageUrl:  String,
});

const EscrowSchema = new Schema<IEscrow>({
  piAmount:    { type: Number, required: true },
  status:      { type: String, enum: ['pending', 'locked', 'released', 'refunded'], default: 'pending' },
  lockedAt:    Date,
  releasedAt:  Date,
  txId:        String,
}, { _id: false });

const OrderSchema = new Schema<IOrder>(
  {
    ad:           { type: Schema.Types.ObjectId, ref: 'Ad',   required: true },
    buyer:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
    seller:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
    piAmount:     { type: Number, required: true, min: 0 },
    nairaAmount:  { type: Number, required: true, min: 0 },
    pricePerPi:   { type: Number, required: true },
    currency:     { type: String, default: 'NGN' },
    paymentMethod:{ type: String, required: true },
    status: {
      type: String,
      enum: ['payment_pending', 'payment_sent', 'completed', 'disputed', 'cancelled', 'refunded'],
      default: 'payment_pending',
    },
    escrow:          { type: EscrowSchema, required: true },
    messages:        [MessageSchema],
    paymentDeadline: Date,
    completedAt:     Date,
    cancelledAt:     Date,
    cancelReason:      String,
    disputeReason:     String,
    buyerWalletAddress: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

OrderSchema.index({ buyer: 1, status: 1 });
OrderSchema.index({ seller: 1, status: 1 });
OrderSchema.index({ ad: 1 });

export const Order = mongoose.model<IOrder>('Order', OrderSchema);