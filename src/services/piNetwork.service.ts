/**
 * piNetwork.service.ts
 *
 * Implements the real Pi Network two-step U2A payment handshake:
 *
 *   1. Frontend calls window.Pi.createPayment()
 *   2. Pi SDK fires onReadyForServerApproval(paymentId)
 *      → Frontend POSTs paymentId to /api/payment/approve
 *      → Backend calls Pi Platform POST /v2/payments/:id/approve
 *   3. Pi SDK fires onReadyForServerCompletion(paymentId, txid)
 *      → Frontend POSTs { paymentId, txid } to /api/payment/complete
 *      → Backend calls Pi Platform POST /v2/payments/:id/complete
 *
 * After step 3 the payment is on-chain and the invest logic runs.
 *
 * References the pattern from the provided paymentService.ts example.
 */

import axios from "axios";
import { PiTransferResult } from "../types";
import { logger } from "../utils/logger";
import StellarSdk from 'stellar-sdk';
import { config } from "../config";

// ── Platform API client ───────────────────────────────────────────────────

const platformApiClient = axios.create({
  baseURL: config.piNetworkApiBase || "https://api.minepi.com",
  timeout: 20_000,
  headers: {
    Authorization: `Key ${config.piApiKey}`,
    "Content-Type": "application/json",
  },
});

// ── DTO shapes from Pi Platform ───────────────────────────────────────────

export interface PiPaymentDTO {
  identifier:   string;
  user_uid:     string;
  amount:       number;
  memo:         string;
  metadata:     Record<string, unknown>;
  from_address: string;
  status: {
    developer_approved:    boolean;
    transaction_verified:  boolean;
    developer_completed:   boolean;
    cancelled:             boolean;
    user_cancelled:        boolean;
  };
  transaction: {
    txid:    string;
    verified: boolean;
    _link:   string;
  } | null;
  created_at: string;
}

// ── Logging helpers ───────────────────────────────────────────────────────

function logPlatformError(err: unknown, ctx: string): void {
  if (axios.isAxiosError(err)) {
    const axErr = err as import("axios").AxiosError;
    console.error(`[Pi Platform] ${ctx}`, {
      url:    axErr.config?.url,
      method: axErr.config?.method,
      status: axErr.response?.status,
      data:   axErr.response?.data,
    });
  } else {
    logger.error(`[Pi Platform] ${ctx}`, err);
  }
}

// ── Fetch payment details ─────────────────────────────────────────────────

export async function getPiPayment(paymentId: string): Promise<PiPaymentDTO> {
  const res = await platformApiClient.get<PiPaymentDTO>(`/v2/payments/${paymentId}`);
  return res.data;
}

// ── Approve payment (step 2 in the handshake) ─────────────────────────────
// Called by: POST /api/payment/approve

export async function approvePiPayment(
  paymentId: string
): Promise<{ success: boolean; payment: PiPaymentDTO; error?: string }> {
  try {
    const payment = await getPiPayment(paymentId);

    if (payment.status.developer_approved) {
      console.log(`[Pi] Payment ${paymentId} already approved — idempotent OK`);
      return { success: true, payment };
    }

    if (payment.status.cancelled || payment.status.user_cancelled) {
      return { success: false, payment, error: "Payment already cancelled" };
    }

    await platformApiClient.post(`/v2/payments/${paymentId}/approve`);
    const approved = await getPiPayment(paymentId);

    console.log(`[Pi] Payment ${paymentId} approved — uid=${payment.user_uid} amount=${payment.amount}π`);
    return { success: true, payment: approved };
  } catch (err) {
    logPlatformError(err, `approvePiPayment(${paymentId})`);
    const msg = axios.isAxiosError(err)
      ? ((err as import("axios").AxiosError<{error?:string}>).response?.data?.error ?? (err as Error).message)
      : String(err);
    throw new Error(`Payment approval failed: ${msg}`);
  }
}

// ── Complete payment (step 3 in the handshake) ────────────────────────────
// Called by: POST /api/payment/complete

export async function completePiPayment(
  paymentId: string,
  txid: string
): Promise<{ success: boolean; payment: PiPaymentDTO; error?: string }> {
  try {
    if (!txid) throw new Error("txid is required to complete a payment");

    const payment = await getPiPayment(paymentId);
    console.log(`[Pi] Completing payment ${paymentId}`, payment);

    if (payment.status.developer_completed) {
      console.log(`[Pi] Payment ${paymentId} already completed — idempotent OK`);
      return { success: true, payment };
    }

    if (!payment.status.developer_approved) {
      throw new Error("Payment has not been approved yet — cannot complete");
    }

    if (payment.status.cancelled || payment.status.user_cancelled) {
      throw new Error("Cannot complete a cancelled payment");
    }

    await platformApiClient.post(`/v2/payments/${paymentId}/complete`, { txid });
    const completed = await getPiPayment(paymentId);

    console.log(`[Pi] Payment ${paymentId} completed on-chain — txid=${txid}`);
    return { success: true, payment: completed };
  } catch (err) {
    logPlatformError(err, `completePiPayment(${paymentId}, ${txid})`);
    const msg = axios.isAxiosError(err)
      ? ((err as import("axios").AxiosError<{error?:string}>).response?.data?.error ?? (err as Error).message)
      : String(err);
    throw new Error(`Payment completion failed: ${msg}`);
  }
}

// ── Cancel payment ────────────────────────────────────────────────────────
// Called by: POST /api/payment/cancelled-payment

export async function cancelPiPayment(
  paymentId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const payment = await getPiPayment(paymentId);

    if (payment.status.cancelled || payment.status.user_cancelled) {
      console.log(`[Pi] Payment ${paymentId} already cancelled — idempotent OK`);
      return { success: true };
    }

    await platformApiClient.post(`/v2/payments/${paymentId}/cancel`);
    console.log(`[Pi] Payment ${paymentId} cancelled`);
    return { success: true };
  } catch (err) {
    logPlatformError(err, `cancelPiPayment(${paymentId})`);
    return { success: false, error: String(err) };
  }
}

// ── Handle incomplete payment ─────────────────────────────────────────────
// Called by: POST /api/payment/incomplete
// Mirrors processIncompletePayment from the provided example.

export async function handleIncompletePayment(
  paymentId: string,
  txid?: string,
  txLink?: string
): Promise<{ success: boolean; message: string }> {
  try {
    // If we have a txid already, the payment landed on-chain but wasn't
    // completed server-side — complete it now.
    if (txid) {
      // Optionally verify memo on Horizon before completing
      if (txLink) {
        try {
          const horizonRes = await axios.get(txLink, { timeout: 20_000 });
          const blockchainMemo: string = horizonRes.data?.memo ?? "";
          console.log(`[Pi] Horizon memo for incomplete payment: "${blockchainMemo}"`);
          // Memo should match paymentId — log a warning if it doesn't but don't block
          if (blockchainMemo && blockchainMemo !== paymentId) {
            console.warn(`[Pi] Memo mismatch: expected ${paymentId}, got ${blockchainMemo}`);
          }
        } catch (horizonErr) {
          console.warn("[Pi] Could not verify memo on Horizon:", horizonErr);
        }
      }

      await completePiPayment(paymentId, txid);
      return {
        success: true,
        message: `Incomplete payment ${paymentId} completed via txid ${txid}`,
      };
    }

    // No txid — payment started but never hit the chain; cancel it.
    await cancelPiPayment(paymentId);
    return {
      success: true,
      message: `Incomplete payment ${paymentId} had no txid — cancelled`,
    };
  } catch (err) {
    logPlatformError(err, `handleIncompletePayment(${paymentId})`);
    throw err;
  }
}


const PI_API_BASE = 'https://api.minepi.com';

export interface PiMeResponse {
  uid: string;
  username: string;
}

/**
 * Verifies a Pi accessToken by calling Pi's /me endpoint.
 * Returns the authoritative { uid, username } on success.
 * Throws if the token is invalid or the call fails.
 */
export async function verifyPiToken(accessToken: string): Promise<PiMeResponse> {
  try {
    const response = await axios.get<PiMeResponse>(`${config.piNetworkApiBase}/v2/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      timeout: 8000,
    });

    const { uid, username } = response.data;

    if (!uid || !username) {
      throw new Error('Pi /me returned incomplete identity data');
    }

    logger.info(`Pi token verified for uid=${uid} username=${username}`);
    return { uid, username };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      logger.warn(`Pi token verification failed [HTTP ${status}]`);
      if (status === 401 || status === 403) {
        throw new Error('Invalid or expired Pi access token');
      }
    }
    logger.error('Pi /me request error:', err);
    throw new Error('Could not verify Pi identity — please try again');
  }
}

const piServer = new StellarSdk.Horizon.Server('https://api.testnet.minepi.com');

export const createA2UPayment = (
  recipientPiUid: string,
  amount: number, 
  memo: string = "Memo for a2u payment", 
  metadata: any = {}, 
) => {
  const body =  {amount, memo, metadata, uid: recipientPiUid};

  let paymentIdentifier;
  let recipientAddress;

  try {
    platformApiClient.post(`/v2/payments`, body,).then(response => {
      paymentIdentifier = response.data.identifier;
      recipientAddress = response.data.recipient;
    });

    if (!recipientAddress || !paymentIdentifier) {
      return {
        success: false,
        error: "Failed to create A2U payment"
      }
    }
    
    return {
      success: true,
      data: {recipientAddress, paymentIdentifier}
    }
  } catch (error: any) {
    return {
      success: false,
      error: "Error creating A2U payment"
    }
  }
}

export const loadAppAccount = (walletAddress: string) => {
  try {
    const appAccount = piServer.loadAccount(walletAddress);

    const baseFee = piServer.fetchBaseFee();
    if (!appAccount || !baseFee){
      return {
        success: false,
        error: "failed to load Pi server"
      }
    }
    return {
      success: true,
      data: {appAccount, baseFee}
    }
  } catch (error: any) {
    return {
      success: false,
      error: "Error creating A2U payment"
    }
  }
}

export const buildA2Utransaction = (
  recipientAddress: string,
  paymentIdentifier: string,
  mySecretSeed: string = "S_YOUR_SECRET_SEED",
  amount: number
) => {
  // create a payment operation which will be wrapped in a transaction
  let payment = StellarSdk.Operation.payment({
    destination: recipientAddress,
    asset: StellarSdk.Asset.native(),
    amount: amount.toString()
  });

  const accountResult = loadAppAccount(config.appWalletAddress || "");

  // 180 seconds timeout
  const timebounds = piServer.fetchTimebounds(180);

  let transaction = new StellarSdk.TransactionBuilder(accountResult.data?.appAccount, {
    fee: accountResult.data?.baseFee,
    networkPassphrase: "Pi Testnet", // use "Pi Network" for mainnet transaction
    timebounds: timebounds
  })
  .addOperation(payment)
  // IMPORTANT! DO NOT forget to include the payment id as memo
  .addMemo(StellarSdk.Memo.text(paymentIdentifier));
  
  transaction = transaction.build();

  // See the "Obtain your wallet's private key" section above to get this.
  // And DON'T HARDCODE IT, treat it like a production secret.
  // const mySecretSeed = "S_YOUR_SECRET_SEED"; // NEVER expose your secret seed to public, starts with S
  const myKeypair = StellarSdk.Keypair.fromSecret(mySecretSeed);
  transaction.sign(myKeypair);

  let txid = piServer.submitTransaction(transaction);

  // check if the response status is 200 
  platformApiClient.post(`/v2/payments/${paymentIdentifier}/complete`, {txid})
  .then(response => {
    if (response.status === 200) {
      return {
        success: true,
        data: {txid, paymentId: paymentIdentifier  }
      }
    }
  }).catch( error => {
      return {
        success: false,
        error: "Error building A2U transaction"
      }
    }
  );
}