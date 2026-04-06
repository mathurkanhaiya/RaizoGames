import { query } from "../db";
import { adjustBalance } from "./userService";
import { recordDeposit } from "./riskService";
import axios from "axios";

const OXAPAY_API = "https://api.oxapay.com";
const OXAPAY_KEY = process.env.OXAPAY_API_KEY!;

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

export async function createOxaPayInvoice(userId: number, amountUSD: number): Promise<{ payUrl: string; orderId: string } | null> {
  const orderId = `DEP_${userId}_${Date.now()}`;

  try {
    const response = await axios.post(
      `${OXAPAY_API}/merchants/request`,
      {
        merchant: OXAPAY_KEY,
        amount: amountUSD,
        currency: "USDT",
        lifeTime: 30,
        feePaidByPayer: 0,
        underPaidCover: 5,
        callbackUrl: `${process.env.WEBHOOK_URL || ""}/api/webhook/oxapay`,
        returnUrl: `https://t.me/${process.env.BOT_USERNAME || "RaizoPvPBot"}`,
        description: `RAIZO GAMES Deposit - User ${userId}`,
        orderId,
      },
      { timeout: 10000 }
    );

    if (response.data?.result === 100) {
      const trackId = response.data.trackId || orderId;
      await query(
        `INSERT INTO deposits (user_id, method, amount, usd_amount, status, oxapay_order_id)
         VALUES ($1, 'usdt', $2, $2, 'pending', $3)`,
        [userId, amountUSD, trackId]
      );
      return { payUrl: response.data.payLink, orderId: trackId };
    }
  } catch {
    // Fallback to manual deposit
  }

  // Fallback — record pending deposit with a direct link
  await query(
    `INSERT INTO deposits (user_id, method, amount, usd_amount, status, oxapay_order_id)
     VALUES ($1, 'usdt', $2, $2, 'pending', $3)`,
    [userId, amountUSD, orderId]
  );

  return {
    payUrl: `https://oxapay.com/pay/${orderId}`,
    orderId,
  };
}

export async function confirmOxaPayDeposit(orderId: string, amountPaid: number): Promise<boolean> {
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
  await grantReferralOnDeposit(dep.user_id, amountPaid);

  return true;
}

// Record Stars deposit from a real Telegram Stars (XTR) invoice payment
export async function recordStarsDeposit(
  userId: number,
  starsCount: number,
  telegramChargeId?: string
): Promise<{ lockedUntil: Date; usdAmount: number }> {
  const usdAmount = starsCount * 0.01;
  const lockedUntil = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO deposits (user_id, method, amount, usd_amount, status, stars_count, locked_until, tx_hash)
     VALUES ($1, 'stars', $2, $2, 'pending', $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [userId, usdAmount, starsCount, lockedUntil, telegramChargeId || null]
  );

  return { lockedUntil, usdAmount };
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

  const wasFirstDeposit = parseFloat(user.total_deposited) === 0;
  if (!wasFirstDeposit) return;

  const commission = amount * 0.05;
  await adjustBalance(user.referral_id, commission, 0, "referral", `Referral commission from user ${userId} first deposit`);
  await query(
    `INSERT INTO referral_earnings (referrer_id, referee_id, tier, amount, source_type)
     VALUES ($1, $2, 1, $3, 'deposit')`,
    [user.referral_id, userId, commission]
  );
}

export async function getDepositHistory(userId: number, limit = 10): Promise<DepositRecord[]> {
  const result = await query(
    "SELECT * FROM deposits WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit]
  );
  return result.rows;
}
