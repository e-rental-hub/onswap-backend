import mongoose, { Document, Schema } from 'mongoose';
import { PaymentMethod } from './Ad';

export type OrderStatus =
  | 'pending'
  | 'payment_pending'
  | 'payment_sent'
  | 'escrow_locked'
  | 'completed'
  | 'disputed'
  | 'cancelled'
  | 'refunded';

export interface IEscrow {
  piAmount: number;
  lockedAt?: Date;
  releasedAt?: Date;
  txId?: string;
  status: 'pending' | 'locked' | 'released' | 'refunded';
}

export interface IMessage {
  sender: mongoose.Types.ObjectId;
  content: string;
  timestamp: Date;
  type: 'text' | 'system' | 'payment_proof';
  imageUrl?: string;
}

export interface IOrder extends Document {
  ad: mongoose.Types.ObjectId;
  buyer: mongoose.Types.ObjectId;
  seller: mongoose.Types.ObjectId;
  piAmount: number;
  nairaAmount: number;
  pricePerPi: number;
  currency: string;
  paymentMethod: PaymentMethod;
  status: OrderStatus;
  escrow: IEscrow;
  messages: IMessage[];
  paymentDeadline?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  cancelReason?: string;
  disputeReason?: string;
  paymentProofUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const EscrowSchema = new Schema<IEscrow>({
  piAmount: { type: Number, required: true },
  lockedAt: Date,
  releasedAt: Date,
  txId: String,
  status: { type: String, enum: ['pending', 'locked', 'released', 'refunded'], default: 'pending' },
});

const MessageSchema = new Schema<IMessage>({
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  type: { type: String, enum: ['text', 'system', 'payment_proof'], default: 'text' },
  imageUrl: String,
});

const OrderSchema = new Schema<IOrder>(
  {
    ad: { type: Schema.Types.ObjectId, ref: 'Ad', required: true },
    buyer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    piAmount: { type: Number, required: true, min: 0 },
    nairaAmount: { type: Number, required: true, min: 0 },
    pricePerPi: { type: Number, required: true },
    currency: { type: String, default: 'NGN' },
    paymentMethod: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'payment_pending', 'payment_sent', 'escrow_locked', 'completed', 'disputed', 'cancelled', 'refunded'],
      default: 'pending',
    },
    escrow: { type: EscrowSchema, required: true },
    messages: [MessageSchema],
    paymentDeadline: Date,
    completedAt: Date,
    cancelledAt: Date,
    cancelReason: String,
    disputeReason: String,
    paymentProofUrl: String,
  },
  { timestamps: true }
);

OrderSchema.index({ buyer: 1, status: 1 });
OrderSchema.index({ seller: 1, status: 1 });
OrderSchema.index({ ad: 1 });

export const Order = mongoose.model<IOrder>('Order', OrderSchema);
