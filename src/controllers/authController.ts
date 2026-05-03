import { Request, Response } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import type { StringValue } from 'ms';
import mongoose from 'mongoose';
import { User, IPaymentMethodDetailDoc } from '../models/User';
import { verifyPiToken } from '../services/piNetwork.service';
import { AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'pi-p2p-secret-change-me';
// Cast to StringValue so TypeScript accepts the expiresIn option correctly.
// Valid formats: '7d', '24h', '60m', '3600s' — anything the `ms` library understands.
const JWT_EXPIRES = (process.env.JWT_EXPIRES || '24h') as StringValue;

const signToken = (id: string, piUid: string, username: string): string => {
  const opts: SignOptions = { expiresIn: JWT_EXPIRES };
  return jwt.sign({ id, piUid, username }, JWT_SECRET, opts);
};

const safeUser = (user: InstanceType<typeof User>) => ({
  id: user.id,
  piUid: user.piUid,
  username: user.username,
  displayName: user.displayName,
  phone: user.phone,
  kycVerified: user.kycVerified,
  rating: user.rating,
  totalTrades: user.totalTrades,
  completedTrades: user.completedTrades,
  completionRate: user.completionRate,
  paymentMethods: user.paymentMethods,
  createdAt: user.createdAt,
});

// ─── Pi Authentication (upsert) ───────────────────────────────────────────────

/**
 * POST /api/v1/auth/pi
 *
 * Flow:
 *  1. Receive { accessToken, uid, username, displayName? } from frontend
 *  2. Verify accessToken against Pi Platform /me  ← server-side check
 *  3. Confirm returned uid matches the claimed uid
 *  4. Upsert user (create on first login, update token on subsequent logins)
 *  5. Return our own JWT + user profile
 */
export const piAuth = async (req: Request, res: Response): Promise<void> => {
  try {
    const { accessToken, uid: claimedUid, username: claimedUsername, displayName, phone } = req.body as {
      accessToken: string;
      uid: string;
      username: string;
      displayName?: string;
      phone?: string;
    };

    // ── Step 1: Verify token with Pi Platform ──
    const piIdentity = await verifyPiToken(accessToken);

    // ── Step 2: Guard against spoofed uid/username in request body ──
    if (piIdentity.uid !== claimedUid) {
      logger.warn(`Pi uid mismatch: claimed=${claimedUid} verified=${piIdentity.uid}`);
      res.status(401).json({ success: false, message: 'Pi identity mismatch — authentication rejected' });
      return;
    }

    // ── Step 3: Upsert user ──
    let user = await User.findOne({ piUid: piIdentity.uid });

    if (!user) {
      // First login — create account
      user = await User.create({
        piUid: piIdentity.uid,
        username: piIdentity.username,
        accessToken,
        displayName: displayName || piIdentity.username,
        phone,
      });
      logger.info(`New pioneer registered: ${piIdentity.username} (uid=${piIdentity.uid})`);
    } else {
      // Returning user — refresh token + username (Pi usernames can change)
      user.accessToken = accessToken;
      user.username = piIdentity.username;
      if (displayName) user.displayName = displayName;
      if (phone) user.phone = phone;
      await user.save();
      logger.info(`Pioneer logged in: ${piIdentity.username} (uid=${piIdentity.uid})`);
    }

    const token = signToken(user.id, user.piUid, user.username);

    res.status(user.isNew ? 201 : 200).json({
      success: true,
      token,
      user: safeUser(user),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authentication failed';
    logger.error('piAuth error:', err);
    res.status(401).json({ success: false, message });
  }
};

// ─── Get current user ─────────────────────────────────────────────────────────

export const getMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    res.json({ success: true, user: safeUser(user) });
  } catch (err) {
    logger.error('getMe error:', err);
    res.status(500).json({ success: false, message: 'Failed to load profile' });
  }
};

// ─── Update profile ───────────────────────────────────────────────────────────

export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { displayName, phone } = req.body as { displayName?: string; phone?: string };
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    if (displayName) user.displayName = displayName;
    if (phone !== undefined) user.phone = phone;
    await user.save();

    logger.info(`Profile updated: ${user.username}`);
    res.json({ success: true, user: safeUser(user) });
  } catch (err) {
    logger.error('updateProfile error:', err);
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
};

// ─── Payment Methods ──────────────────────────────────────────────────────────

/** GET /api/v1/auth/payment-methods */
export const getPaymentMethods = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id).select('paymentMethods');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    res.json({ success: true, paymentMethods: user.paymentMethods });
  } catch (err) {
    logger.error('getPaymentMethods error:', err);
    res.status(500).json({ success: false, message: 'Failed to load payment methods' });
  }
};

/** POST /api/v1/auth/payment-methods */
export const addPaymentMethod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const { type, label, accountName, accountNumber, bankName, isDefault } = req.body;

    // If this one is being set as default, clear all others first
    if (isDefault) {
      user.paymentMethods.forEach((pm) => { pm.isDefault = false; });
    }

    // Prevent exact duplicates (same type + accountNumber)
    const exists = user.paymentMethods.some(
      (pm) => pm.type === type && pm.accountNumber === accountNumber
    );
    if (exists) {
      res.status(409).json({ success: false, message: 'This account is already saved' });
      return;
    }

    // If it's the first one, make it default automatically
    const shouldBeDefault = isDefault || user.paymentMethods.length === 0;

    // Let Mongoose generate _id automatically — avoids subdocument type mismatch
    user.paymentMethods.push({
      type,
      label,
      accountName,
      accountNumber,
      bankName,
      isDefault: shouldBeDefault,
      createdAt: new Date(),
    } as IPaymentMethodDetailDoc);

    await user.save();
    logger.info(`Payment method added for ${user.username}: ${type}`);
    res.status(201).json({ success: true, paymentMethods: user.paymentMethods });
  } catch (err) {
    logger.error('addPaymentMethod error:', err);
    res.status(500).json({ success: false, message: 'Failed to add payment method' });
  }
};

/** PATCH /api/v1/auth/payment-methods/:pmId */
export const updatePaymentMethod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const pm = user.paymentMethods.id(req.params.pmId);
    if (!pm) { res.status(404).json({ success: false, message: 'Payment method not found' }); return; }

    const { type, label, accountName, accountNumber, bankName, isDefault } = req.body;

    if (isDefault) {
      user.paymentMethods.forEach((p) => { p.isDefault = false; });
    }

    if (type !== undefined) pm.type = type;
    if (label !== undefined) pm.label = label;
    if (accountName !== undefined) pm.accountName = accountName;
    if (accountNumber !== undefined) pm.accountNumber = accountNumber;
    if (bankName !== undefined) pm.bankName = bankName;
    if (isDefault !== undefined) pm.isDefault = isDefault;

    await user.save();
    logger.info(`Payment method updated: ${pm._id} for ${user.username}`);
    res.json({ success: true, paymentMethods: user.paymentMethods });
  } catch (err) {
    logger.error('updatePaymentMethod error:', err);
    res.status(500).json({ success: false, message: 'Failed to update payment method' });
  }
};

/** DELETE /api/v1/auth/payment-methods/:pmId */
export const deletePaymentMethod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const pmIndex = user.paymentMethods.findIndex(
      (pm) => pm.id.toString() === req.params.pmId
    );
    if (pmIndex === -1) { res.status(404).json({ success: false, message: 'Payment method not found' }); return; }

    const wasDefault = user.paymentMethods[pmIndex].isDefault;
    user.paymentMethods.splice(pmIndex, 1);

    // Auto-promote next method to default if the deleted one was default
    if (wasDefault && user.paymentMethods.length > 0) {
      user.paymentMethods[0].isDefault = true;
    }

    await user.save();
    logger.info(`Payment method deleted: ${req.params.pmId} for ${user.username}`);
    res.json({ success: true, paymentMethods: user.paymentMethods });
  } catch (err) {
    logger.error('deletePaymentMethod error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete payment method' });
  }
};

/** PATCH /api/v1/auth/payment-methods/:pmId/set-default */
export const setDefaultPaymentMethod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const pm = user.paymentMethods.id(req.params.pmId);
    if (!pm) { res.status(404).json({ success: false, message: 'Payment method not found' }); return; }

    user.paymentMethods.forEach((p) => { p.isDefault = false; });
    pm.isDefault = true;

    await user.save();
    logger.info(`Default payment method set: ${pm._id} for ${user.username}`);
    res.json({ success: true, paymentMethods: user.paymentMethods });
  } catch (err) {
    logger.error('setDefaultPaymentMethod error:', err);
    res.status(500).json({ success: false, message: 'Failed to set default' });
  }
};