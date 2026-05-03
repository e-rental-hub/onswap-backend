import { Router } from 'express';

import {
  piAuth, getMe, updateProfile,
  getPaymentMethods, addPaymentMethod, updatePaymentMethod,
  deletePaymentMethod, setDefaultPaymentMethod,
} from '../controllers/authController';

import {
  getBalance, getTransactions, getDepositInfo,
  approveDeposit, completeDeposit, cancelDeposit, incompleteDeposit,
} from '../controllers/walletController';

import { getAds, getAdById, createAd, updateAd, deleteAd, hardDeleteAd, getMyAds } from '../controllers/adController';
import { createOrder, getOrders, getOrderById, updateOrderStatus, sendMessage } from '../controllers/orderController';

import { authenticate, validateBody } from '../middleware/auth';

import {
  piAuthSchema, updateProfileSchema,
  addPaymentMethodSchema, updatePaymentMethodSchema,
  approveDepositSchema, completeDepositSchema, cancelDepositSchema, incompleteDepositSchema,
  createAdSchema, updateAdSchema, createOrderSchema, sendMessageSchema, updateOrderStatusSchema,
} from '../validators/schemas';

const router = Router();

// ─── Auth ─────────────────────────────────────────────────────────────────────

router.post('/auth/pi',      validateBody(piAuthSchema), piAuth);
router.get ('/auth/me',      authenticate, getMe);
router.patch('/auth/profile', authenticate, validateBody(updateProfileSchema), updateProfile);

router.get   ('/auth/payment-methods',                  authenticate, getPaymentMethods);
router.post  ('/auth/payment-methods',                  authenticate, validateBody(addPaymentMethodSchema), addPaymentMethod);
router.patch ('/auth/payment-methods/:pmId',            authenticate, validateBody(updatePaymentMethodSchema), updatePaymentMethod);
router.delete('/auth/payment-methods/:pmId',            authenticate, deletePaymentMethod);
router.patch ('/auth/payment-methods/:pmId/set-default',authenticate, setDefaultPaymentMethod);

// ─── Wallet ───────────────────────────────────────────────────────────────────

router.get ('/wallet/balance',             authenticate, getBalance);
router.get ('/wallet/transactions',        authenticate, getTransactions);
router.get ('/wallet/deposit-info',        authenticate, getDepositInfo);
router.post('/wallet/deposit/approve',     authenticate, validateBody(approveDepositSchema),    approveDeposit);
router.post('/wallet/deposit/complete',    authenticate, validateBody(completeDepositSchema),   completeDeposit);
router.post('/wallet/deposit/cancel',      authenticate, validateBody(cancelDepositSchema),     cancelDeposit);
router.post('/wallet/deposit/incomplete',  authenticate, validateBody(incompleteDepositSchema), incompleteDeposit);

// ─── Ads ──────────────────────────────────────────────────────────────────────

router.get   ('/ads',     getAds);
router.get   ('/ads/my',  authenticate, getMyAds);
router.get   ('/ads/:id', getAdById);
router.post  ('/ads',     authenticate, validateBody(createAdSchema), createAd);
router.patch ('/ads/:id', authenticate, validateBody(updateAdSchema), updateAd);
router.delete('/ads/:id',      authenticate, deleteAd);
router.delete('/ads/:id/hard', authenticate, hardDeleteAd);

// ─── Orders ───────────────────────────────────────────────────────────────────

router.post  ('/orders',                  authenticate, validateBody(createOrderSchema), createOrder);
router.get   ('/orders',                  authenticate, getOrders);
router.get   ('/orders/:id',              authenticate, getOrderById);
router.patch ('/orders/:id/status',       authenticate, validateBody(updateOrderStatusSchema), updateOrderStatus);
router.post  ('/orders/:id/messages',     authenticate, sendMessage);

export default router;