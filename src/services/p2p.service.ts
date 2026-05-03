
// import mongoose from "mongoose";
// import { Pioneer }   from "../models/Pioneer";
// import { Transaction } from "../models/Transaction";
// import { IpoState }  from "../models/IpoState";
// import { calcSpotPrice, pushSpotPrice, getIpoDayFromDb } from "./ipoState.service";
// import { approvePiPayment, completePiPayment, getPiPayment } from "./piNetwork.service";
// import { transferA2U } from "./piNetwork.service";

// // ── Types ─────────────────────────────────────────────────────────────────

// export interface InvestResult {
//   success: boolean;
//   piBalance: number;
//   spotPrice: number;
//   txId?: string;
//   error?: string;
// }

// export interface WithdrawResult {
//   success: boolean;
//   amountReturned: number;
//   newPiBalance: number;
//   spotPrice: number;
//   txId?: string;
//   error?: string;
// }

// // ── Step 1: Approve payment ───────────────────────────────────────────────
// // Called from POST /api/payment/approve.
// // Validates the payment belongs to this app, then approves it on Pi Platform.

// export async function approvePayment(
//   paymentId: string
// ): Promise<{ success: boolean; amount: number; userUid: string; memo: string; error?: string }> {
//   const { success, payment, error } = await approvePiPayment(paymentId);

//   if (!success) {
//     return { success: false, amount: 0, userUid: "", memo: "", error };
//   }

//   // Sanity-check: memo should identify this as a MapCapIPO payment
//   if (!payment.memo.includes("MapCapIPO")) {
//     console.warn(`[IPO] Payment ${paymentId} memo does not identify as MapCapIPO: "${payment.memo}"`);
//   }

//   return {
//     success:  true,
//     amount:   payment.amount,
//     userUid:  payment.user_uid,
//     memo:     payment.memo,
//   };
// }

// // ── Step 2: Complete investment ───────────────────────────────────────────
// // Called from POST /api/payment/complete.
// // Confirms the on-chain txid with Pi Platform, then runs the DB invest logic.

// export async function completeInvestment(
//   paymentId: string,
//   txid:      string,
//   uid:       string,
//   username:  string
// ): Promise<InvestResult> {
//   // Confirm on Pi Platform
//   const { success, payment, error } = await completePiPayment(paymentId, txid);
//   if (!success) {
//     return { success: false, piBalance: 0, spotPrice: 0, error };
//   }

//   const amount = payment.amount;
//   if (amount < 1) {
//     return { success: false, piBalance: 0, spotPrice: 0, error: "Payment amount too small (minimum 1 π)" };
//   }

//   // Run DB invest logic now that payment is confirmed on-chain
//   return investPi(uid, username, amount, paymentId);
// }

// async function investPi(
//   uid:       string,
//   username:  string,
//   amount:    number,
//   txId:      string
// ): Promise<InvestResult> {
//   const session = await mongoose.startSession();
//   session.startTransaction();

//   try {
//     // Upsert pioneer
//     const pioneer = await Pioneer.findOneAndUpdate(
//       { uid },
//       {
//         $setOnInsert: { uid, username },
//         $inc: { piBalance: amount, totalInvested: amount },
//       },
//       { upsert: true, new: true, session }
//     );

//     // Increment pool total
//     const state = await IpoState.findOneAndUpdate(
//       { singleton: true },
//       { $inc: { totalPiInPool: amount } },
//       { new: true, session }
//     );

//     const newPoolTotal = state?.totalPiInPool ?? amount;
//     const spot         = calcSpotPrice(newPoolTotal);

//     // Refresh investor count
//     const investorCount = await Pioneer.countDocuments({ piBalance: { $gt: 0 } });
//     await IpoState.updateOne(
//       { singleton: true },
//       { $set: { totalInvestors: investorCount } },
//       { session }
//     );

//     // Audit record
//     await Transaction.create(
//       [{ pioneerUid: uid, type: "invest", amount, spotPriceAtTime: spot, txId }],
//       { session }
//     );

//     await session.commitTransaction();

//     // Push live spot-price point to history (outside the session — non-fatal)
//     const day = await getIpoDayFromDb();
//     pushSpotPrice(newPoolTotal, day).catch(err =>
//       console.error("[IPO] pushSpotPrice after invest failed:", err)
//     );

//     return { success: true, piBalance: pioneer.piBalance, spotPrice: spot, txId };
//   } catch (err) {
//     await session.abortTransaction();
//     throw err;
//   } finally {
//     session.endSession();
//   }
// }