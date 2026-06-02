import { Router } from 'express';

import {
  piAuth, getMe, updateProfile,
  getuserAccountDetails, addUserAccountDetail, updateUserAccountDetail,
  deleteUserAccountDetail, setDefaultUserAccountDetail,
  getPiWalletAddresses, addPiWalletAddress, updatePiWalletAddress,
  deletePiWalletAddress, setDefaultPiWalletAddress,
  setPreferredCurrency,
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
  addPiWalletAddressSchema, updatePiWalletAddressSchema,
  approveDepositSchema, completeDepositSchema, cancelDepositSchema, incompleteDepositSchema,
  createAdSchema, updateAdSchema, createOrderSchema, sendMessageSchema, updateOrderStatusSchema,
  setUserCurrencySchema,
} from '../validators/schemas';

const router = Router();

// ─── Auth ─────────────────────────────────────────────────────────────────────

router.post('/auth/pi',      validateBody(piAuthSchema), piAuth);
router.get ('/auth/me',      authenticate, getMe);
router.patch('/auth/profile', authenticate, validateBody(updateProfileSchema), updateProfile);

router.post ('/auth/set-currency',                      authenticate, validateBody(setUserCurrencySchema), setPreferredCurrency);

router.get   ('/auth/account-details',                  authenticate, getuserAccountDetails);
router.post  ('/auth/account-details',                  authenticate, validateBody(addPaymentMethodSchema), addUserAccountDetail);
router.patch ('/auth/account-details/:pmId',            authenticate, validateBody(updatePaymentMethodSchema), updateUserAccountDetail);
router.delete('/auth/account-details/:pmId',            authenticate, deleteUserAccountDetail);
router.patch ('/auth/account-details/:pmId/set-default',authenticate, setDefaultUserAccountDetail);
  
// ─── Pi Wallet Addresses ──────────────────────────────────────────────────────

router.get   ('/auth/pi-wallets',                  authenticate, getPiWalletAddresses);
router.post  ('/auth/pi-wallets',                  authenticate, validateBody(addPiWalletAddressSchema),    addPiWalletAddress);
router.patch ('/auth/pi-wallets/:waId',            authenticate, validateBody(updatePiWalletAddressSchema), updatePiWalletAddress);
router.delete('/auth/pi-wallets/:waId',            authenticate, deletePiWalletAddress);
router.patch ('/auth/pi-wallets/:waId/set-default',authenticate, setDefaultPiWalletAddress);

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
router.post  ('/orders/:id/messages',     authenticate, validateBody(sendMessageSchema), sendMessage);

export default router;