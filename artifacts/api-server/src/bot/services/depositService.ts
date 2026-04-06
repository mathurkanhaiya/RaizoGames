import { query } from "../db";
import { adjustBalance } from "./userService";
import { recordDeposit } from "./riskService";
import axios from "axios";

const OXAPAY_API = "https://api.oxapay.com";
// OxaPay has TWO separate keys:
//   OXAPAY_API_KEY      = General API key (swaps, rates)
//   OXAPAY_MERCHANT_KEY = Merchant API key (payment invoices) ← required for deposits
const OXAPAY_MERCHANT_KEY = process.env.OXAPAY_MERCHANT_KEY || process.env.OXAPAY_API_KEY || "";
const BOT_USERNAME = process.env.BOT_USERNAME || "RaizoPvPBot";

export interface DepositRecord {
  id: number;
  user_id: number;
  method: string;
  amount: number;
  usd_amount: number;
  status: string;
  tx_hash?: string;
  stars_count?: number;
  oxapay_order_id?: string;
  locked_until?: Date;
  created_at: Date;
  confirmed_at?: Date;
}

export async function createOxaPayInvoice(
  userId: number,
  amountUSD: number
): Promise<{ payUrl: string; orderId: string } | null> {
  if (!OXAPAY_MERCHANT_KEY) {
    console.error("OXAPAY_MERCHANT_KEY is not set");
    return null;
  }

  const orderId = `DEP_${userId}_${Date.now()}`;
  const webhookUrl = process.env.WEBHOOK_URL
    ? `${process.env.WEBHOOK_URL}/api/webhook/oxapay`
    : "";

  console.log(`[OxaPay] Creating invoice — user: ${userId}, amount: $${amountUSD}, keySet: ${!!OXAPAY_MERCHANT_KEY}, keyLen: ${OXAPAY_MERCHANT_KEY.length}`);

  try {
    // OxaPay Merchant API: key goes in the body as "merchant"
    const response = await axios.post(
      `${OXAPAY_API}/merchants/request`,
      {
        merchant: OXAPAY_MERCHANT_KEY,
        amount: amountUSD,
        currency: "USDT",
        lifeTime: 30,
        feePaidByPayer: 0,
        underPaidCover: 5,
        callbackUrl: webhookUrl,
        returnUrl: `https://t.me/${BOT_USERNAME}`,
        description: `RAIZO GAMES Deposit — User ${userId}`,
        orderId,
      },
      { timeout: 15000 }
    );

    const data = response.data;
    console.log(`[OxaPay] Response: result=${data?.result}, message=${data?.message}, hasPayLink=${!!data?.payLink}`);

    // OxaPay result 100 = success
    if (data?.result === 100 && data?.payLink) {
      const trackId: string = data.trackId || orderId;
      await query(
        `INSERT INTO deposits (user_id, method, amount, usd_amount, status, oxapay_order_id)
         VALUES ($1, 'usdt', $2, $2, 'pending', $3)`,
        [userId, amountUSD, trackId]
      );
      console.log(`[OxaPay] Invoice created — trackId: ${trackId}`);
      return { payUrl: data.payLink, orderId: trackId };
    }

    console.error(`[OxaPay] Failed — result: ${data?.result}, message: ${data?.message}`);
    return null;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "response" in err) {
      const axErr = err as { response?: { status?: number; data?: unknown }; message?: string };
      console.error("[OxaPay] API error:", axErr.response?.status, JSON.stringify(axErr.response?.data));
    } else {
      console.error("[OxaPay] Request failed:", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

export async function confirmOxaPayDeposit(
  orderId: string,
  amountPaid: number
): Promise<boolean> {
  const depResult = await query(
    "SELECT * FROM deposits WHERE oxapay_order_id=$1 AND status='pending'",
    [orderId]
  );
  if (!depResult.rows[0]) return false;
  const dep = depResult.rows[0];

  await query(
    "UPDATE deposits SET status='confirmed', usd_amount=$1, amount=$1, confirmed_at=NOW() WHERE id=$2",
    [amountPaid, dep.id]
  );

  await adjustBalance(dep.user_id, amountPaid, 0, "deposit", `USDT deposit via OxaPay`, orderId);
  await recordDeposit(amountPaid);

  // Update total_deposited on user
  await query(
    "UPDATE bot_users SET total_deposited = total_deposited + $1, updated_at=NOW() WHERE id=$2",
    [amountPaid, dep.user_id]
  );

  await grantReferralOnDeposit(dep.user_id, amountPaid);
  return true;
}

// Record a real Telegram Stars (XTR) invoice payment — 21-day lock before credit
export async function recordStarsDeposit(
  userId: number,
  starsCount: number,
  telegramChargeId?: string
): Promise<{ lockedUntil: Date; usdAmount: number }> {
  const usdAmount = starsCount * 0.01;
  const lockedUntil = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);

  // Use tx_hash to store the Telegram charge ID for refund purposes
  await query(
    `INSERT INTO deposits (user_id, method, amount, usd_amount, status, stars_count, locked_until, tx_hash)
     VALUES ($1, 'stars', $2, $2, 'pending', $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [userId, usdAmount, starsCount, lockedUntil, telegramChargeId || null]
  );

  return { lockedUntil, usdAmount };
}

// Refund Stars using the Telegram charge ID (admin action)
export async function refundStarsByChargeId(
  chargeId: string
): Promise<{ success: boolean; userId?: number; starsCount?: number; alreadyRefunded?: boolean }> {
  const depResult = await query(
    "SELECT * FROM deposits WHERE tx_hash=$1 AND method='stars'",
    [chargeId]
  );
  const dep = depResult.rows[0];
  if (!dep) return { success: false };
  if (dep.status === "refunded") return { success: false, alreadyRefunded: true };

  await query(
    "UPDATE deposits SET status='refunded', confirmed_at=NOW() WHERE id=$1",
    [dep.id]
  );

  // If already credited (confirmed), deduct the USD amount back
  if (dep.status === "confirmed") {
    try {
      await adjustBalance(
        dep.user_id,
        -parseFloat(dep.usd_amount),
        0,
        "refund",
        `Stars refund — Charge ID: ${chargeId}`
      );
    } catch {
      // Balance may already be zero — still mark refunded
    }
  }

  return { success: true, userId: dep.user_id, starsCount: dep.stars_count };
}

// Unlock Stars deposits that have passed the 21-day lock
export async function processLockedStars(): Promise<void> {
  const unlocked = await query(
    `SELECT * FROM deposits 
     WHERE method='stars' AND status='pending' AND locked_until < NOW()`
  );

  for (const dep of unlocked.rows) {
    await query(
      "UPDATE deposits SET status='confirmed', confirmed_at=NOW() WHERE id=$1",
      [dep.id]
    );
    await adjustBalance(
      dep.user_id,
      parseFloat(dep.usd_amount),
      0,
      "deposit",
      `Stars deposit unlocked (${dep.stars_count} ⭐)`,
      String(dep.id)
    );
    await query(
      "UPDATE bot_users SET total_deposited = total_deposited + $1, updated_at=NOW() WHERE id=$2",
      [parseFloat(dep.usd_amount), dep.user_id]
    );
    await recordDeposit(parseFloat(dep.usd_amount));
    await grantReferralOnDeposit(dep.user_id, parseFloat(dep.usd_amount));
  }
}

export async function getPendingStars(userId: number): Promise<DepositRecord[]> {
  const result = await query(
    "SELECT * FROM deposits WHERE user_id=$1 AND method='stars' AND status='pending' ORDER BY created_at DESC",
    [userId]
  );
  return result.rows;
}

async function grantReferralOnDeposit(userId: number, amount: number): Promise<void> {
  const userRes = await query(
    "SELECT referral_id, total_deposited FROM bot_users WHERE id=$1",
    [userId]
  );
  const user = userRes.rows[0];
  if (!user?.referral_id) return;

  // Only first-deposit referral bonus
  const depositCount = await query(
    "SELECT COUNT(*) as cnt FROM deposits WHERE user_id=$1 AND status='confirmed'",
    [userId]
  );
  if (parseInt(depositCount.rows[0].cnt) > 1) return;

  const commission = amount * 0.05;
  await adjustBalance(
    user.referral_id,
    commission,
    0,
    "referral",
    `Referral commission from user ${userId} first deposit`
  );
  await query(
    `INSERT INTO referral_earnings (referrer_id, referee_id, tier, amount, source_type)
     VALUES ($1, $2, 1, $3, 'deposit')`,
    [user.referral_id, userId, commission]
  );
}

export async function getDepositHistory(userId: number, limit = 20): Promise<DepositRecord[]> {
  const result = await query(
    "SELECT * FROM deposits WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit]
  );
  return result.rows;
}
