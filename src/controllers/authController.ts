import { Request, Response } from 'express';
import jwt, { SignOptions }  from 'jsonwebtoken';
import type { StringValue }  from 'ms';
import { User, IPaymentMethodDetailDoc, IPiWalletAddressDoc } from '../models/User';
import { verifyPiToken }     from '../services/piNetwork.service';
import { AuthRequest }       from '../middleware/auth';
import { logger }            from '../utils/logger';
import { config } from '../config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const JWT_SECRET = config.jwtSecret || 'pi-p2p-secret-change-me';
// Cast to StringValue so TypeScript accepts the expiresIn option correctly.
// Valid formats: '7d', '24h', '60m', '3600s' — anything the `ms` library understands.
const JWT_EXPIRES = (config.jwtExpires || '24h') as StringValue;

const signToken = (id: string, piUid: string, username: string): string => {
  const opts: SignOptions = { expiresIn: JWT_EXPIRES };
  return jwt.sign({ id, piUid, username }, JWT_SECRET, opts);
};

const safeUser = (user: InstanceType<typeof User>) => ({
  id:              user.id,
  piUid:           user.piUid,
  username:        user.username,
  displayName:     user.displayName,
  phone:           user.phone,
  kycVerified:     user.kycVerified,
  rating:          user.rating,
  totalTrades:     user.totalTrades,
  completedTrades: user.completedTrades,
  completionRate:  user.completionRate,
  // Wallet balances — included so the frontend can bootstrap without a separate /wallet/balance call
  piBalance:       user.piBalance,
  lockedBalance:   user.lockedBalance,
  paymentMethods:     user.paymentMethods,
  piWalletAddresses:  user.piWalletAddresses,
  createdAt:          user.createdAt,
});

function toId(field: unknown): string {
  if (field == null) return '';
  // Populated document — has _id property
  if (typeof field === 'object' && '_id' in (field as object)) {
    return (field as { _id: { toString(): string } })._id.toString();
  }
  // Raw ObjectId or string
  return String(field);
}

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
    const { accessToken, uid: claimedUid, displayName, phone } = req.body as {
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
        piUid:         piIdentity.uid,
        username:      piIdentity.username,
        accessToken,
        displayName:   displayName || piIdentity.username,
        phone,
        // Capture wallet address from /v2/me so A2U transfers work without a separate API call
        walletAddress: piIdentity.wallet_address,
      });
      logger.info(`New pioneer registered: ${piIdentity.username} (uid=${piIdentity.uid})`);
    } else {
      user.accessToken = accessToken;
      user.username    = piIdentity.username;
      // Always refresh wallet address — user may have re-created their Pi wallet
      if (piIdentity.wallet_address) user.walletAddress = piIdentity.wallet_address;
      if (displayName) user.displayName = displayName;
      if (phone)       user.phone       = phone;
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
    if (displayName)       user.displayName = displayName;
    if (phone !== undefined) user.phone     = phone;
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

    if (isDefault) user.paymentMethods.forEach((pm) => { pm.isDefault = false; });

    const exists = user.paymentMethods.some(
      (pm) => pm.type === type && pm.accountNumber === accountNumber
    );
    if (exists) { res.status(409).json({ success: false, message: 'This account is already saved' }); return; }

    const shouldBeDefault = isDefault || user.paymentMethods.length === 0;
    user.paymentMethods.push({
      type, label, accountName, accountNumber, bankName,
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
    if (isDefault) user.paymentMethods.forEach((p) => { p.isDefault = false; });
    if (type          !== undefined) pm.type          = type;
    if (label         !== undefined) pm.label         = label;
    if (accountName   !== undefined) pm.accountName   = accountName;
    if (accountNumber !== undefined) pm.accountNumber = accountNumber;
    if (bankName      !== undefined) pm.bankName      = bankName;
    if (isDefault     !== undefined) pm.isDefault     = isDefault;

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
      (pm) => toId(pm._id) === req.params.pmId
    );
    if (pmIndex === -1) { res.status(404).json({ success: false, message: 'Payment method not found' }); return; }

    const wasDefault = user.paymentMethods[pmIndex].isDefault;
    user.paymentMethods.splice(pmIndex, 1);
    if (wasDefault && user.paymentMethods.length > 0) user.paymentMethods[0].isDefault = true;

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

// ─── Pi Wallet Addresses ──────────────────────────────────────────────────────

const STELLAR_RE = /^G[A-Z2-7]{55}$/;

export const getPiWalletAddresses = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id).select('piWalletAddresses');
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    res.json({ success: true, piWalletAddresses: user.piWalletAddresses });
  } catch (err) {
    logger.error('getPiWalletAddresses error:', err);
    res.status(500).json({ success: false, message: 'Failed to load wallet addresses' });
  }
};

export const addPiWalletAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { address, tag, isDefault } = req.body as {
      address: string; tag: string; isDefault?: boolean;
    };

    if (!STELLAR_RE.test(address.trim())) {
      res.status(400).json({ success: false, message: 'Invalid Pi wallet address — must start with G and be 56 characters' });
      return;
    }

    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const exists = user.piWalletAddresses.some((w) => w.address === address.trim());
    if (exists) {
      res.status(409).json({ success: false, message: 'This wallet address is already saved' });
      return;
    }

    const shouldBeDefault = isDefault || user.piWalletAddresses.length === 0;
    if (shouldBeDefault) user.piWalletAddresses.forEach((w) => { w.isDefault = false; });

    user.piWalletAddresses.push({
      address:   address.trim(),
      tag:       tag.trim(),
      isDefault: shouldBeDefault,
      createdAt: new Date(),
    } as IPiWalletAddressDoc);

    await user.save();
    logger.info(`Pi wallet address added for ${user.username}: ${tag}`);
    res.status(201).json({ success: true, piWalletAddresses: user.piWalletAddresses });
  } catch (err) {
    logger.error('addPiWalletAddress error:', err);
    res.status(500).json({ success: false, message: 'Failed to add wallet address' });
  }
};

export const updatePiWalletAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const wa = user.piWalletAddresses.id(req.params.waId);
    if (!wa) { res.status(404).json({ success: false, message: 'Wallet address not found' }); return; }

    const { tag, isDefault } = req.body as { tag?: string; isDefault?: boolean };

    if (isDefault) user.piWalletAddresses.forEach((w) => { w.isDefault = false; });
    if (tag       !== undefined) wa.tag       = tag.trim();
    if (isDefault !== undefined) wa.isDefault = isDefault;

    await user.save();
    logger.info(`Pi wallet address updated: ${wa._id} for ${user.username}`);
    res.json({ success: true, piWalletAddresses: user.piWalletAddresses });
  } catch (err) {
    logger.error('updatePiWalletAddress error:', err);
    res.status(500).json({ success: false, message: 'Failed to update wallet address' });
  }
};

export const deletePiWalletAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const idx = user.piWalletAddresses.findIndex(
      (w) => toId(w._id) === req.params.waId
    );
    if (idx === -1) { res.status(404).json({ success: false, message: 'Wallet address not found' }); return; }

    const wasDefault = user.piWalletAddresses[idx].isDefault;
    user.piWalletAddresses.splice(idx, 1);
    if (wasDefault && user.piWalletAddresses.length > 0) {
      user.piWalletAddresses[0].isDefault = true;
    }

    await user.save();
    logger.info(`Pi wallet address deleted: ${req.params.waId} for ${user.username}`);
    res.json({ success: true, piWalletAddresses: user.piWalletAddresses });
  } catch (err) {
    logger.error('deletePiWalletAddress error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete wallet address' });
  }
};

export const setDefaultPiWalletAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const wa = user.piWalletAddresses.id(req.params.waId);
    if (!wa) { res.status(404).json({ success: false, message: 'Wallet address not found' }); return; }

    user.piWalletAddresses.forEach((w) => { w.isDefault = false; });
    wa.isDefault = true;

    await user.save();
    logger.info(`Default Pi wallet address set: ${wa._id} for ${user.username}`);
    res.json({ success: true, piWalletAddresses: user.piWalletAddresses });
  } catch (err) {
    logger.error('setDefaultPiWalletAddress error:', err);
    res.status(500).json({ success: false, message: 'Failed to set default wallet address' });
  }
};