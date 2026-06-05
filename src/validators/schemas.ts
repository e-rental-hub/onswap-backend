import { z } from 'zod';
import { AdTypeEnum, CurrencyEnum, PaymentMethodEnum } from '../models/enum';

// ─── Payment method ───────────────────────────────────────────────────────────

export const paymentMethodDetailSchema = z.object({
  type:          z.nativeEnum(PaymentMethodEnum),
  currency:      z.nativeEnum(CurrencyEnum).default(CurrencyEnum.NGN),
  label:         z.string().min(1).max(60),
  accountName:   z.string().min(1).max(80),
  accountNumber: z.string().min(1).max(20),
  bankName:      z.string().max(80).optional(),
  isDefault:     z.boolean().optional().default(false),
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const piAuthSchema = z.object({
  accessToken: z.string().min(10),
  uid:         z.string().min(1),
  username:    z.string().min(1),
  displayName: z.string().min(1).max(60).optional(),
  phone:       z.string().optional(),
});

export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(60).optional(),
  phone:       z.string().optional(),
});

export const setUserCurrencySchema = z.object({
  currency: z.nativeEnum(CurrencyEnum),
});

// ─── Saved payment methods ────────────────────────────────────────────────────

export const addPaymentMethodSchema    = paymentMethodDetailSchema;
export const updatePaymentMethodSchema = paymentMethodDetailSchema.partial().extend({
  isDefault: z.boolean().optional(),
});

// ─── Pi Wallet Addresses ──────────────────────────────────────────────────────

/** Stellar public key: starts with G, exactly 56 chars, base32 alphabet */
const stellarAddressRegex = /^G[A-Z2-7]{55}$/;

export const addPiWalletAddressSchema = z.object({
  address:   z.string()
    .length(56, 'Pi wallet address must be exactly 56 characters')
    .regex(stellarAddressRegex, 'Invalid Pi wallet address — must start with G followed by 55 uppercase letters/numbers'),
  tag:       z.string().min(1, 'Tag is required').max(60, 'Tag must be 60 characters or less').trim(),
  isDefault: z.boolean().optional().default(false),
});

export const updatePiWalletAddressSchema = z.object({
  tag:       z.string().min(1).max(60).trim().optional(),
  isDefault: z.boolean().optional(),
});

// ─── Wallet / deposit ─────────────────────────────────────────────────────────

export const approveDepositSchema = z.object({
  paymentId: z.string().min(1),
});

export const completeDepositSchema = z.object({
  paymentId: z.string().min(1),
  txid:      z.string().min(1),
});

export const cancelDepositSchema = z.object({
  paymentId: z.string().min(1),
});

export const incompleteDepositSchema = z.object({
  paymentInfo: z.object({
    identifier:  z.string().min(1),
    transaction: z.object({
      txid:  z.string(),
      _link: z.string(),
    }).optional(),
  }),
});

// ─── Ads ──────────────────────────────────────────────────────────────────────

export const createAdSchema = z.object({
  type:       z.nativeEnum(AdTypeEnum),
  piAmount:   z.number().positive(),
  minLimit:   z.number().positive(),
  maxLimit:   z.number().positive(),
  pricePerPi: z.number().positive(),
  currency:   z.nativeEnum(CurrencyEnum).default(CurrencyEnum.NGN).optional(),
  paymentMethods: z.array(
    z.nativeEnum(PaymentMethodEnum)
  ).min(1),
  sellerAccountDetailId: z.string().min(1).optional(),
  buyerPiWalletId:    z.string().min(1).optional(),
  paymentWindow: z.number().min(5).max(120).default(15),
  terms:         z.string().max(500).optional(),
  autoReply:     z.string().max(300).optional(),
}).refine((d) => d.minLimit <= d.maxLimit, { message: 'minLimit must be ≤ maxLimit' });

export const updateAdSchema = z.object({
  // Financial — sell ads only; decrease only (guarded server-side)
  piAmount:      z.number().positive().optional(),
  // Pricing
  pricePerPi:    z.number().positive().optional(),
  minLimit:      z.number().positive().optional(),
  maxLimit:      z.number().positive().optional(),
  // Payment
  paymentMethods: z.array(
    z.nativeEnum(PaymentMethodEnum)
  ).min(1).optional(),
  sellerAccountDetailId:z.string().min(1).optional(),
  buyerPiWalletId:    z.string().min(1).optional(),
  paymentWindow:  z.number().min(5).max(120).optional(),
  terms:          z.string().max(500).optional(),
  autoReply:      z.string().max(300).optional(),
  // Status toggle (active ↔ paused only; cancel uses DELETE)
  status:         z.enum(['active', 'paused']).optional(),
}).refine(
  (d) => !(d.minLimit && d.maxLimit) || d.minLimit <= d.maxLimit,
  { message: 'minLimit must be ≤ maxLimit' }
);

// ─── Orders ───────────────────────────────────────────────────────────────────

export const createOrderSchema = z.object({
  adId:               z.string().min(1),
  piAmount:           z.number().positive(),
  paymentMethod:      z.nativeEnum(PaymentMethodEnum),
  sellerAccountDetailId: z.string().min(1).optional(),
  buyerWalletAddressId: z.string().min(1).optional(),
});

export const sendMessageSchema = z.object({
  content:  z.string().min(1).max(1000),
  type:     z.enum(['text', 'payment_proof']).default('text'),
  imageUrl: z.string().url().optional(),
});

export const updateOrderStatusSchema = z.object({
  action: z.enum(['confirm_payment', 'release_escrow', 'cancel', 'dispute']),
  reason: z.string().optional(),
});