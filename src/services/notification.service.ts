import admin from "firebase-admin";
import { ServiceAccount } from "firebase-admin";
import { MessagingTopicManagementResponse } from "firebase-admin/messaging";

// ─── Init (call once at app startup) ────────────────────────────────────────

let initialized = false;

export function initFirebase(): void {
  if (initialized) return;

  const serviceAccount: ServiceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID!,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
    privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
  };

  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  initialized = true;
  console.log("[Firebase] Initialized ✓");
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>; // must be string values for FCM
  imageUrl?: string;
}

export interface SendResult {
  successCount: number;
  failureCount: number;
  failedTokens: string[];
}

// ─── Core send helpers ────────────────────────────────────────────────────────

/**
 * Send to a single FCM token.
 */
export async function sendToToken(
  token: string,
  payload: PushPayload
): Promise<string> {
  const message: admin.messaging.Message = {
    token,
    notification: {
      title: payload.title,
      body: payload.body,
      ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
    },
    data: payload.data,
    webpush: {
      fcmOptions: { link: payload.data?.url },
      notification: {
        title: payload.title,
        body: payload.body,
        icon: "/icons/icon-192x192.png",
        badge: "/icons/badge-72x72.png",
        ...(payload.imageUrl && { image: payload.imageUrl }),
      },
    },
  };

  const messageId = await admin.messaging().send(message);
  return messageId;
}

/**
 * Send to multiple FCM tokens (up to 500 per call — FCM multicast limit).
 * Returns counts + any tokens that are no longer valid so you can purge them.
 */
export async function sendToTokens(
  tokens: string[],
  payload: PushPayload
): Promise<SendResult> {
  if (!tokens.length) return { successCount: 0, failureCount: 0, failedTokens: [] };

  // FCM multicast limit is 500
  const chunks = chunkArray(tokens, 500);
  const result: SendResult = { successCount: 0, failureCount: 0, failedTokens: [] };

  for (const chunk of chunks) {
    const message: admin.messaging.MulticastMessage = {
      tokens: chunk,
      notification: {
        title: payload.title,
        body: payload.body,
        ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
      },
      data: payload.data,
      webpush: {
        fcmOptions: { link: payload.data?.url },
        notification: {
          title: payload.title,
          body: payload.body,
          icon: "/icons/icon-192x192.png",
          badge: "/icons/badge-72x72.png",
        },
      },
    };

    const batchResponse = await admin.messaging().sendEachForMulticast(message);

    result.successCount += batchResponse.successCount;
    result.failureCount += batchResponse.failureCount;

    batchResponse.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code;
        // These codes mean the token is stale — safe to remove from DB
        const isStale =
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token";
        if (isStale) result.failedTokens.push(chunk[idx]);
      }
    });
  }

  return result;
}

/**
 * Send to a Firebase topic (e.g. "payments", "all-users").
 */
export async function sendToTopic(
  topic: string,
  payload: PushPayload
): Promise<string> {
  const message: admin.messaging.Message = {
    topic,
    notification: { title: payload.title, body: payload.body },
    data: payload.data,
    webpush: {
      notification: {
        title: payload.title,
        body: payload.body,
        icon: "/icons/icon-192x192.png",
        badge: "/icons/badge-72x72.png",
      },
    },
  };

  return admin.messaging().send(message);
}

// ─── Topic subscription helpers ──────────────────────────────────────────────

export async function subscribeToTopic(tokens: string[], topic: string): Promise<MessagingTopicManagementResponse> {
  return admin.messaging().subscribeToTopic(tokens, topic);
}
 
export async function unsubscribeFromTopic(tokens: string[], topic: string): Promise<MessagingTopicManagementResponse> {
  return admin.messaging().unsubscribeFromTopic(tokens, topic);
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
