import { Response }        from 'express';
import mongoose            from 'mongoose';
import { AuthRequest }     from '../middleware/auth';
import { User }            from '../models/User';
import { WalletTransaction } from '../models/WalletTransaction';
import {
  creditDeposit,
  getWalletSummary,
  MIN_DEPOSIT_PI,
  DEPOSIT_FEE_RATE,
} from '../services/walletService';
import {
  approvePiPayment,
  completePiPayment,
  cancelPiPayment,
  handleIncompletePayment,
} from '../services/piNetwork.service';
import { logger } from '../utils/logger';

// ─── GET /wallet/balance ──────────────────────────────────────────────────────

export const getBalance = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const summary = await getWalletSummary(
      new mongoose.Types.ObjectId(req.user!.id)
    );
    res.json({ success: true, ...summary });
  } catch (err) {
    logger.error('getBalance error:', err);
    res.status(500).json({ success: false, message: 'Failed to load balance' });
  }
};

// ─── GET /wallet/transactions ─────────────────────────────────────────────────

export const getTransactions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = 1, limit = 30, type } = req.query;
    const filter: Record<string, unknown> = { userId: req.user!.id };
    if (type) filter.type = type;

    const [txs, total] = await Promise.all([
      WalletTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      WalletTransaction.countDocuments(filter),
    ]);

    res.json({ success: true, transactions: txs, total, page: Number(page) });
  } catch (err) {
    logger.error('getTransactions error:', err);
    res.status(500).json({ success: false, message: 'Failed to load transactions' });
  }
};

// ─── GET /wallet/deposit-info ─────────────────────────────────────────────────
// Returns the fee rate and minimum deposit so the frontend can display them
// before the user initiates a payment.

export const getDepositInfo = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({
    success:       true,
    minDeposit:    MIN_DEPOSIT_PI,
    feeRate:       DEPOSIT_FEE_RATE,
    feePercent:    `${(DEPOSIT_FEE_RATE * 100).toFixed(1)}%`,
  });
};

// ─── POST /wallet/deposit/approve ────────────────────────────────────────────
// Step 2 of the Pi payment handshake: approve the payment on Pi Platform.

export const approveDeposit = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { paymentId } = req.body as { paymentId: string };
    if (!paymentId) { res.status(400).json({ success: false, message: 'paymentId required' }); return; }

    const { success, payment, error } = await approvePiPayment(paymentId);
    if (!success) { res.status(400).json({ success: false, message: error }); return; }

    // Validate minimum amount
    if (payment.amount < MIN_DEPOSIT_PI) {
      await cancelPiPayment(paymentId);
      res.status(400).json({
        success: false,
        message: `Minimum deposit is ${MIN_DEPOSIT_PI}π`,
      });
      return;
    }

    logger.info(`[Wallet] Deposit approved: uid=${req.user!.id} paymentId=${paymentId} amount=${payment.amount}π`);
    res.json({ success: true, amount: payment.amount, paymentId });
  } catch (err) {
    logger.error('approveDeposit error:', err);
    res.status(500).json({ success: false, message: 'Approval failed' });
  }
};

// ─── POST /wallet/deposit/complete ───────────────────────────────────────────
// Step 3 of the Pi payment handshake: confirm txid, credit balance.

export const completeDeposit = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { paymentId, txid } = req.body as { paymentId: string; txid: string };
    if (!paymentId || !txid) {
      res.status(400).json({ success: false, message: 'paymentId and txid required' });
      return;
    }

    const { success, payment, error } = await completePiPayment(paymentId, txid);
    if (!success) { res.status(400).json({ success: false, message: error }); return; }

    const userId  = new mongoose.Types.ObjectId(req.user!.id);
    const userUid = req.user!.piUid;

    const result = await creditDeposit(
      userId,
      userUid,
      payment.amount,
      paymentId,
      txid,
      `Pi deposit — ${new Date().toLocaleDateString()}`
    );

    logger.info(`[Wallet] Deposit complete: uid=${userUid} net=${result.netAmount}π newBalance=${result.newBalance}π`);
    res.json({
      success:       true,
      newBalance:    result.newBalance,
      netAmount:     result.netAmount,
      fee:           result.fee,
      transactionId: result.transactionId,
    });
  } catch (err) {
    logger.error('completeDeposit error:', err);
    res.status(500).json({ success: false, message: 'Failed to complete deposit' });
  }
};

// ─── POST /wallet/deposit/cancel ─────────────────────────────────────────────

export const cancelDeposit = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { paymentId } = req.body as { paymentId: string };
    if (!paymentId) { res.status(400).json({ success: false, message: 'paymentId required' }); return; }
    await cancelPiPayment(paymentId);
    res.json({ success: true });
  } catch (err) {
    logger.error('cancelDeposit error:', err);
    res.status(500).json({ success: false, message: 'Cancel failed' });
  }
};

// ─── POST /wallet/deposit/incomplete ─────────────────────────────────────────
// Called by PiAuthButton's onIncompletePaymentFound — resolves dangling payments.

export const incompleteDeposit = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { paymentInfo } = req.body as {
      paymentInfo: { identifier: string; transaction?: { txid: string; _link: string } };
    };
    const { identifier, transaction } = paymentInfo;
    const result = await handleIncompletePayment(
      identifier,
      transaction?.txid,
      transaction?._link
    );

    // If it was completed, credit the balance
    if (result.success && transaction?.txid) {
      const { success, payment } = await completePiPayment(identifier, transaction.txid).catch(() => ({ success: false, payment: null }));
      if (success && payment) {
        await creditDeposit(
          new mongoose.Types.ObjectId(req.user!.id),
          req.user!.piUid,
          payment.amount,
          identifier,
          transaction.txid,
          'Recovered incomplete deposit'
        ).catch((e) => logger.warn('[Wallet] creditDeposit on incomplete recovery failed:', e));
      }
    }

    res.json(result);
  } catch (err) {
    logger.error('incompleteDeposit error:', err);
    res.status(500).json({ success: false, message: 'Failed to handle incomplete payment' });
  }
};
