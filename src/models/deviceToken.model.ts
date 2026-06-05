import { Schema, model, Document } from "mongoose";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IDeviceToken extends Document {
  userId: string;       // Pi username or your platform user ID
  fcmToken: string;
  platform: "web" | "android" | "ios";
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const DeviceTokenSchema = new Schema<IDeviceToken>(
  {
    userId:   { type: String, required: true, index: true },
    fcmToken: { type: String, required: true, unique: true },
    platform: { type: String, enum: ["web", "android", "ios"], default: "web" },
  },
  { timestamps: true }
);

// ─── Helpers (used by the route handlers) ────────────────────────────────────

/** Upsert a token for a user. Returns true if it was newly inserted. */
export async function upsertToken(
  userId: string,
  fcmToken: string,
  platform: IDeviceToken["platform"] = "web"
): Promise<boolean> {
  const result = await DeviceToken.updateOne(
    { fcmToken },
    { $set: { userId, platform } },
    { upsert: true }
  );
  return result.upsertedCount > 0;
}

/** Remove one specific token (e.g. on logout). */
export async function removeToken(fcmToken: string): Promise<void> {
  await DeviceToken.deleteOne({ fcmToken });
}

/** Bulk-remove stale tokens returned by FCM after a multicast send. */
export async function pruneStaleTokens(tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  await DeviceToken.deleteMany({ fcmToken: { $in: tokens } });
}

/** Get all active FCM tokens for a user. */
export async function getTokensForUser(userId: string): Promise<string[]> {
  const docs = await DeviceToken.find({ userId }, "fcmToken").lean();
  return docs.map((d) => d.fcmToken);
}

/** Get tokens for multiple users in one query. */
export async function getTokensForUsers(userIds: string[]): Promise<string[]> {
  const docs = await DeviceToken.find(
    { userId: { $in: userIds } },
    "fcmToken"
  ).lean();
  return docs.map((d) => d.fcmToken);
}

export const DeviceToken = model<IDeviceToken>("DeviceToken", DeviceTokenSchema);
