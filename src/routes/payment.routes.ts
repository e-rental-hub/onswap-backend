/**
 * payment.routes.ts
 *
 * Handles the Pi Network U2A payment two-step handshake callbacks.
 *
 * The frontend (PiPayButton) fires these in order:
 *
 *   1. onReadyForServerApproval(paymentId)
 *      → POST /api/payment/approve  { paymentId }
 *
 *   2. onReadyForServerCompletion(paymentId, txid)
 *      → POST /api/payment/complete  { paymentId, txid }
 *
 *   3. onCancel(paymentId) [user tapped cancel in Pi dialog]
 *      → POST /api/payment/cancelled-payment  { paymentId }
 *
 *   4. onError(error, payment?) [SDK-level error]
 *      → POST /api/payment/error  { identifier, transaction? }
 *
 *   5. onIncompletePaymentFound(payment) [leftover from previous session]
 *      → POST /api/payment/incomplete  { paymentInfo }
 *
 * NOTE: /approve and /complete require a valid Pi auth token because they
 * must be linked to the authenticated pioneer's uid.
 */

import { Router, Request, Response, NextFunction } from "express";
import { authenticate, AuthRequest } from "../middleware/auth";
import { approvePayment, completeInvestment } from "../services/p2p.service";
import {
  cancelPiPayment,
  handleIncompletePayment,
  getPiPayment,
} from "../services/piNetwork.service";
// import { getIpoState } from "../services/ipoState.service";

const router = Router();

// ── POST /api/payment/approve ─────────────────────────────────────────────
// Step 1: Pioneer's payment is ready for server approval.
// We approve it on Pi Platform. The investment itself is NOT credited yet —
// that happens in /complete after on-chain confirmation.
router.post(
  "/approve",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { paymentId } = req.body as { paymentId: string };

      if (!paymentId || typeof paymentId !== "string") {
        res.status(400).json({ error: "paymentId is required" });
        return;
      }

      // Check IPO is still active
      const state = await getIpoState();
      if (state.ipoStatus !== "active") {
        res.status(409).json({ error: "IPO phase is not active — payments cannot be approved" });
        return;
      }

      const result = await approvePayment(paymentId);

      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }

      res.json({
        success: true,
        message: `Payment ${paymentId} approved`,
        amount:  result.amount,
        memo:    result.memo,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/payment/complete ────────────────────────────────────────────
// Step 2: Pi SDK has confirmed the transaction on-chain.
// We complete it on Pi Platform, then credit the pioneer's investment.
router.post(
  "/complete",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { paymentId, txid } = req.body as { paymentId: string; txid: string };

      if (!paymentId || typeof paymentId !== "string") {
        res.status(400).json({ error: "paymentId is required" });
        return;
      }
      if (!txid || typeof txid !== "string") {
        res.status(400).json({ error: "txid is required" });
        return;
      }

      // Check IPO is still active
      const state = await getIpoState();
      if (state.ipoStatus !== "active") {
        // Payment may have been confirmed on-chain but IPO closed between
        // approve and complete — complete the Pi payment but do NOT invest.
        // The pioneer can request a refund via support.
        await completeInvestment(paymentId, txid, req.pioneerUid!, req.pioneerUsername!);
        res.status(409).json({
          error: "IPO phase closed — payment confirmed on Pi blockchain but investment not credited. Contact support.",
        });
        return;
      }

      const result = await completeInvestment(
        paymentId,
        txid,
        req.pioneerUid!,
        req.pioneerUsername!
      );

      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }

      res.status(201).json({
        success:    true,
        piBalance:  result.piBalance,
        spotPrice:  result.spotPrice,
        txId:       result.txId,
        message:    "Investment confirmed and credited",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/payment/cancelled-payment ───────────────────────────────────
// Pioneer cancelled the payment in the Pi dialog.
// We notify Pi Platform so it releases the payment lock.
router.post(
  "/cancelled-payment",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { paymentId } = req.body as { paymentId: string };

      if (!paymentId || typeof paymentId !== "string") {
        res.status(400).json({ error: "paymentId is required" });
        return;
      }

      const result = await cancelPiPayment(paymentId);

      if (!result.success) {
        res.status(400).json({ error: result.error ?? "Cancellation failed" });
        return;
      }

      res.json({ success: true, message: `Payment ${paymentId} cancelled` });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/payment/incomplete ─────────────────────────────────────────
// Pioneer re-opened the app with a dangling payment from a previous session.
// Pi SDK fires onIncompletePaymentFound — we resolve it (complete or cancel).
router.post(
  "/incomplete",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { paymentInfo } = req.body as {
        paymentInfo: {
          identifier: string;
          transaction?: { txid: string; _link: string } | null;
        };
      };

      if (!paymentInfo?.identifier) {
        res.status(400).json({ error: "paymentInfo.identifier is required" });
        return;
      }

      const { identifier, transaction } = paymentInfo;

      const result = await handleIncompletePayment(
        identifier,
        transaction?.txid,
        transaction?._link
      );

      // If the incomplete payment was completed (had a txid), credit the investment
      if (result.success && transaction?.txid) {
        const ipoState = await getIpoState();
        if (ipoState.ipoStatus === "active") {
          await completeInvestment(
            identifier,
            transaction.txid,
            req.pioneerUid!,
            req.pioneerUsername!
          ).catch(err => {
            // Non-fatal — payment already completed on-chain, invest may already be credited
            console.warn("[Payment] completeInvestment after incomplete recovery:", err.message);
          });
        }
      }

      res.json({ success: true, message: result.message });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/payment/error ───────────────────────────────────────────────
// Pi SDK encountered an error during the payment flow.
// We attempt to recover if there's a txid (complete), or cancel otherwise.
router.post(
  "/error",
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // Body matches the PaymentDTO shape from the Pi Platform
      const { identifier, transaction } = req.body as {
        identifier: string;
        transaction?: { txid: string; _link: string } | null;
      };

      if (!identifier) {
        res.status(400).json({ error: "identifier is required" });
        return;
      }

      // Fetch fresh state from Pi Platform to determine actual status
      const payment = await getPiPayment(identifier).catch(() => null);

      if (payment?.status.developer_completed) {
        // Already done — idempotent
        res.json({ success: true, message: "Payment already completed" });
        return;
      }

      if (transaction?.txid) {
        // Transaction made it on-chain — complete it
        const result = await handleIncompletePayment(
          identifier,
          transaction.txid,
          transaction._link
        );

        if (result.success) {
          const ipoState = await getIpoState();
          if (ipoState.ipoStatus === "active") {
            await completeInvestment(
              identifier,
              transaction.txid,
              req.pioneerUid!,
              req.pioneerUsername!
            ).catch(err =>
              console.warn("[Payment] error-route completeInvestment:", err.message)
            );
          }
        }

        res.json({ success: result.success, message: result.message });
      } else {
        // No txid — cancel the payment
        const result = await cancelPiPayment(identifier);
        res.json({ success: result.success, message: `Payment ${identifier} cancelled due to error` });
      }
    } catch (err) {
      next(err);
    }
  }
);

export default router;