/**
 * piNetwork.service.ts
 *
 * Handles all Pi Network Platform API calls.
 *
 * ── U2A (User-to-App) — Pi deposit flow ──────────────────────────────────────
 *   User initiates via Pi SDK → Pi Platform calls our approve/complete endpoints.
 *   Endpoints: POST /v2/payments/:id/approve  |  POST /v2/payments/:id/complete
 *
 * ── A2U (App-to-User) — Escrow release flow ──────────────────────────────────
 *   Pi Platform's A2U is a pure Stellar transfer — there is NO server-side
 *   "create payment" endpoint. The correct flow is:
 *     1. GET /v2/users/{uid}  → resolve buyer's on-chain wallet address
 *     2. Build + sign + submit Stellar transaction directly to Horizon
 *        (memo = orderId for audit trail)
 *     3. No completePiPayment call needed — the transfer IS the payment
 *
 *   Reference: https://developers.minepi.com/doc/payments (A2U section)
 */

import axios            from 'axios';
import StellarSdk       from 'stellar-sdk';
import { logger }       from '../utils/logger';
import { config }       from '../config';

// ─── Config ───────────────────────────────────────────────────────────────────

const PI_API_BASE        = config.piNetworkApiBase  || 'https://api.minepi.com';
const PI_API_KEY         = config.piApiKey          || '';
const APP_WALLET_ADDRESS = config.appWalletAddress  || '';
const APP_WALLET_SECRET  = config.appWalletSecretSeed || '';
const IS_MAINNET         = (config.piNetwork ?? 'testnet') === 'mainnet';
const NETWORK_PASSPHRASE = IS_MAINNET ? 'Pi Network' : 'Pi Testnet';
const HORIZON_URL        = IS_MAINNET
  ? 'https://api.mainnet.minepi.com'
  : 'https://api.testnet.minepi.com';

const horizonServer = new StellarSdk.Horizon.Server(HORIZON_URL);

/** Authenticated Platform API client — used for U2A approve/complete and user lookup */
const platformApiClient = axios.create({
  baseURL: PI_API_BASE,
  timeout: 20_000,
  headers: {
    Authorization: `Key ${PI_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface PiPaymentDTO {
  identifier:  string;
  user_uid:    string;
  amount:      number;
  memo:        string;
  metadata:    Record<string, unknown>;
  from_address: string;
  to_address?: string;
  status: {
    developer_approved:   boolean;
    transaction_verified: boolean;
    developer_completed:  boolean;
    cancelled:            boolean;
    user_cancelled:       boolean;
  };
  transaction: { txid: string; verified: boolean; _link: string } | null;
  created_at: string;
}

export interface PiMeResponse {
  uid:            string;
  username:       string;
  wallet_address?: string; // on-chain Stellar public key — present when user has opened Pi wallet
}

export interface PiUserDTO {
  uid:             string;
  username:        string;
  wallet_address?: string;  // on-chain Stellar public key
}

export interface A2UResult {
  success:          boolean;
  txid?:            string;
  recipientAddress?: string;
  error?:           string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function logPlatformError(err: unknown, ctx: string): void {
  if (axios.isAxiosError(err)) {
    logger.error(`[Pi Platform] ${ctx}`, {
      url:    err.config?.url,
      status: err.response?.status,
      data:   err.response?.data,
    });
  } else {
    logger.error(`[Pi Platform] ${ctx}`, err);
  }
}

// ─── Token / user verification ────────────────────────────────────────────────

export async function verifyPiToken(accessToken: string): Promise<PiMeResponse> {
  try {
    const res = await axios.get<PiMeResponse>(`${PI_API_BASE}/v2/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 8_000,
    });
    const { uid, username, wallet_address } = res.data;
    if (!uid || !username) throw new Error('Pi /me returned incomplete identity data');
    logger.info(`Pi token verified: uid=${uid} username=${username} wallet=${wallet_address ?? 'none'}`);
    return { uid, username, wallet_address };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      logger.warn(`Pi token verification failed [HTTP ${status}]`);
      if (status === 401 || status === 403) throw new Error('Invalid or expired Pi access token');
    }
    logger.error('Pi /me request error:', err);
    throw new Error('Could not verify Pi identity — please try again');
  }
}

/**
 * Resolve a Pi user's on-chain wallet address from their uid.
 * Uses GET /v2/users/{uid} — requires server-side API key auth.
 */
export async function getPiUserWalletAddress(uid: string): Promise<string> {
  try {
    const res = await platformApiClient.get<PiUserDTO>(`/v2/users/${uid}`);
    const address = res.data.wallet_address;
    if (!address) {
      throw new Error(`User ${uid} has no wallet address (may not have completed KYC or opened Pi wallet)`);
    }
    logger.info(`[Pi] Resolved wallet for uid=${uid}: ${address}`);
    return address;
  } catch (err) {
    logPlatformError(err, `getPiUserWalletAddress(${uid})`);
    const msg = axios.isAxiosError(err)
      ? ((err.response?.data as { error?: string })?.error ?? err.message)
      : String(err);
    throw new Error(`Could not resolve wallet address for user: ${msg}`);
  }
}

// ─── U2A payment helpers (deposit) ───────────────────────────────────────────

export async function getPiPayment(paymentId: string): Promise<PiPaymentDTO> {
  const res = await platformApiClient.get<PiPaymentDTO>(`/v2/payments/${paymentId}`);
  return res.data;
}

export async function approvePiPayment(
  paymentId: string
): Promise<{ success: boolean; payment: PiPaymentDTO; error?: string }> {
  try {
    const payment = await getPiPayment(paymentId);
    if (payment.status.developer_approved) {
      logger.info(`[Pi] Payment ${paymentId} already approved — idempotent`);
      return { success: true, payment };
    }
    if (payment.status.cancelled || payment.status.user_cancelled) {
      return { success: false, payment, error: 'Payment already cancelled' };
    }
    await platformApiClient.post(`/v2/payments/${paymentId}/approve`);
    const approved = await getPiPayment(paymentId);
    logger.info(`[Pi] Payment ${paymentId} approved — amount=${payment.amount}π`);
    return { success: true, payment: approved };
  } catch (err) {
    logPlatformError(err, `approvePiPayment(${paymentId})`);
    const msg = axios.isAxiosError(err)
      ? ((err.response?.data as { error?: string })?.error ?? err.message)
      : String(err);
    throw new Error(`Payment approval failed: ${msg}`);
  }
}

export async function completePiPayment(
  paymentId: string,
  txid: string
): Promise<{ success: boolean; payment: PiPaymentDTO; error?: string }> {
  try {
    if (!txid) throw new Error('txid is required to complete a payment');
    const payment = await getPiPayment(paymentId);
    if (payment.status.developer_completed) {
      logger.info(`[Pi] Payment ${paymentId} already completed — idempotent`);
      return { success: true, payment };
    }
    if (!payment.status.developer_approved) throw new Error('Payment not approved yet');
    if (payment.status.cancelled || payment.status.user_cancelled) {
      throw new Error('Cannot complete a cancelled payment');
    }
    await platformApiClient.post(`/v2/payments/${paymentId}/complete`, { txid });
    const completed = await getPiPayment(paymentId);
    logger.info(`[Pi] Payment ${paymentId} completed — txid=${txid}`);
    return { success: true, payment: completed };
  } catch (err) {
    logPlatformError(err, `completePiPayment(${paymentId}, ${txid})`);
    const msg = axios.isAxiosError(err)
      ? ((err.response?.data as { error?: string })?.error ?? err.message)
      : String(err);
    throw new Error(`Payment completion failed: ${msg}`);
  }
}

export async function cancelPiPayment(
  paymentId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const payment = await getPiPayment(paymentId);
    if (payment.status.cancelled || payment.status.user_cancelled) {
      logger.info(`[Pi] Payment ${paymentId} already cancelled — idempotent`);
      return { success: true };
    }
    await platformApiClient.post(`/v2/payments/${paymentId}/cancel`);
    logger.info(`[Pi] Payment ${paymentId} cancelled`);
    return { success: true };
  } catch (err) {
    logPlatformError(err, `cancelPiPayment(${paymentId})`);
    return { success: false, error: String(err) };
  }
}

export async function handleIncompletePayment(
  paymentId: string,
  txid?: string,
  txLink?: string
): Promise<{ success: boolean; message: string }> {
  try {
    if (txid) {
      if (txLink) {
        try {
          const horizonRes = await axios.get(txLink, { timeout: 20_000 });
          const memo: string = horizonRes.data?.memo ?? '';
          if (memo && memo !== paymentId) {
            logger.warn(`[Pi] Memo mismatch: expected ${paymentId}, got ${memo}`);
          }
        } catch {
          logger.warn('[Pi] Could not verify memo on Horizon');
        }
      }
      await completePiPayment(paymentId, txid);
      return { success: true, message: `Incomplete payment ${paymentId} completed via txid ${txid}` };
    }
    await cancelPiPayment(paymentId);
    return { success: true, message: `Incomplete payment ${paymentId} had no txid — cancelled` };
  } catch (err) {
    logPlatformError(err, `handleIncompletePayment(${paymentId})`);
    throw err;
  }
}

// ─── A2U Stellar transfer ─────────────────────────────────────────────────────

/**
 * Submit a direct Stellar payment from the app wallet to a recipient address.
 *
 * Pi Platform A2U does NOT have a "create payment" server endpoint.
 * The transfer is a raw Stellar transaction submitted directly to Horizon.
 * The orderId is embedded as the Stellar memo for audit purposes.
 *
 * Returns the on-chain transaction hash (txid).
 */
export async function transferPi(
  recipientAddress: string,
  amount:           string,   // string to prevent float precision issues
  orderId:          string,   // used as Stellar memo for auditability
): Promise<string> {
  if (!APP_WALLET_SECRET) throw new Error('APP_WALLET_SECRET is not configured');
  if (!recipientAddress)  throw new Error('recipientAddress is required');

  const keypair      = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET.trim());
  const walletPubKey = APP_WALLET_ADDRESS || keypair.publicKey();
  const account      = await horizonServer.loadAccount(walletPubKey);

  // Verify app wallet has enough balance
  const nativeBalance = account.balances.find(
    (b: { asset_type: string }) => b.asset_type === 'native'
  ) as { balance: string } | undefined;

  if (!nativeBalance || parseFloat(nativeBalance.balance) < parseFloat(amount)) {
    throw new Error(
      `Insufficient app wallet balance. ` +
      `Available: ${nativeBalance?.balance ?? 0}π, required: ${amount}π`
    );
  }

  // Stellar memo is limited to 28 bytes — truncate orderId if needed
  const memoText = orderId.length > 28 ? orderId.slice(-28) : orderId;

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee:               '100000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.payment({
      destination: recipientAddress,
      asset:       StellarSdk.Asset.native(),
      amount:      amount,
    }))
    .addMemo(StellarSdk.Memo.text(memoText))
    .setTimeout(180)
    .build();

  tx.sign(keypair);

  const result = await horizonServer.submitTransaction(tx);
  const txid   = (result as unknown as { hash: string }).hash;

  logger.info(`[Pi A2U] Stellar tx submitted: txid=${txid} amount=${amount}π → ${recipientAddress}`);
  return txid;
}

/**
 * Full A2U release pipeline for a completed P2P escrow order.
 *
 * The buyer's wallet address is passed directly — it was captured and
 * validated (Stellar G... format) when the order was created, so no
 * API lookup is required at release time.
 *
 *   transferPi() — submit Stellar tx directly to Horizon, get txid
 *
 * Returns A2UResult. Stellar tx is atomic — if it fails, no Pi is sent.
 */
export async function releaseToUser(
  buyerWalletAddress: string,
  piAmount:           number,
  orderId:            string,
): Promise<A2UResult> {
  let txid: string | undefined;

  try {
    logger.info(`[Pi A2U] Releasing: orderId=${orderId} amount=${piAmount}π → ${buyerWalletAddress}`);

    txid = await transferPi(
      buyerWalletAddress,
      piAmount.toFixed(7),  // Stellar max 7 decimal places
      orderId,
    );

    logger.info(`[Pi A2U] Release complete: orderId=${orderId} txid=${txid}`);
    return { success: true, txid, recipientAddress: buyerWalletAddress };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(
      `[Pi A2U] Release failed: orderId=${orderId} txid=${txid ?? 'none'} recipient=${buyerWalletAddress}`,
      err
    );
    return { success: false, recipientAddress: buyerWalletAddress, txid, error };
  }
}