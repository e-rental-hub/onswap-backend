import { z } from 'zod';

// ─── Payment method ───────────────────────────────────────────────────────────

export const paymentMethodDetailSchema = z.object({
  type:          z.enum(['bank_transfer', 'opay', 'palmpay', 'kuda', 'moniepoint']),
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

// ─── Saved payment methods ────────────────────────────────────────────────────

export const addPaymentMethodSchema    = paymentMethodDetailSchema;
export const updatePaymentMethodSchema = paymentMethodDetailSchema.partial().extend({
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
  type:       z.enum(['buy', 'sell']),
  piAmount:   z.number().positive(),
  minLimit:   z.number().positive(),
  maxLimit:   z.number().positive(),
  pricePerPi: z.number().positive(),
  currency:   z.string().default('NGN'),
  paymentMethods: z.array(
    z.enum(['bank_transfer', 'opay', 'palmpay', 'kuda', 'moniepoint'])
  ).min(1),
  paymentDetails: z.array(
    z.object({
      type:          z.enum(['bank_transfer', 'opay', 'palmpay', 'kuda', 'moniepoint']),
      label:         z.string(),
      accountName:   z.string().optional(),
      accountNumber: z.string().optional(),
      bankName:      z.string().optional(),
    })
  ).optional().default([]),
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
    z.enum(['bank_transfer', 'opay', 'palmpay', 'kuda', 'moniepoint'])
  ).min(1).optional(),
  paymentDetails: z.array(
    z.object({
      type:          z.enum(['bank_transfer', 'opay', 'palmpay', 'kuda', 'moniepoint']),
      label:         z.string(),
      accountName:   z.string().optional(),
      accountNumber: z.string().optional(),
      bankName:      z.string().optional(),
    })
  ).optional(),
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
  paymentMethod:      z.enum(['bank_transfer', 'opay', 'palmpay', 'kuda', 'moniepoint']),
  /**
   * Buyer's on-chain Pi/Stellar wallet address (starts with G...).
   * Validated as a 56-character Stellar public key.
   * Used by seller to release Pi via A2U transfer on trade completion.
   */
  buyerWalletAddress: z.string()
    .min(56, 'Pi wallet address must be 56 characters')
    .max(56, 'Pi wallet address must be 56 characters')
    .regex(/^G[A-Z2-7]{55}$/, 'Invalid Pi wallet address — must start with G followed by 55 uppercase letters/numbers'),
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