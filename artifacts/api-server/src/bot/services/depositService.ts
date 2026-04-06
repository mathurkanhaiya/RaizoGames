import { query } from "../db";
import { adjustBalance, getUser } from "./userService";
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
  try {
    const response = await axios.post(`${OXAPAY_API}/merchants/request`, {
      merchant: OXAPAY_KEY,
      amount: amountUSD,
      currency: "USDT",
      lifeTime: 30,
      feePaidByPayer: 0,
      underPaidCover: 5,
      callbackUrl: `${process.env.WEBHOOK_URL || ""}/api/webhook/oxapay`,
      returnUrl: `https://t.me/${process.env.BOT_USERNAME || "RaizoPvPBot"}`,
      description: `RAIZO GAMES Deposit - User ${userId}`,
      orderId: `DEP_${userId}_${Date.now()}`,
    });

    if (response.data?.result === 100) {
      const orderId = response.data.trackId || `DEP_${userId}_${Date.now()}`;

      // Create pending deposit record
      await query(
        `INSERT INTO deposits (user_id, method, amount, usd_amount, status, oxapay_order_id)
         VALUES ($1, 'usdt', $2, $2, 'pending', $3)`,
        [userId, amountUSD, orderId]
      );

      return { payUrl: response.data.payLink, orderId };
    }
  } catch (err) {
    // fallback: create manual deposit link
  }

  // Fallback: create manual deposit instruction
  const orderId = `DEP_${userId}_${Date.now()}`;
  await query(
    `INSERT INTO deposits (user_id, method, amount, usd_amount, status, oxapay_order_id)
     VALUES ($1, 'usdt', $2, $2, 'pending', $3)`,
    [userId, 0, orderId]
  );

  return { payUrl: `https://oxapay.com/pay/${orderId}`, orderId };
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

  // Check referral reward on first deposit
  await grantReferralOnDeposit(dep.user_id, amountPaid);

  return true;
}

export async function recordStarsDeposit(userId: number, starsCount: number): Promise<{ lockedUntil: Date; usdAmount: number }> {
  const usdAmount = starsCount * 0.01;
  const lockedUntil = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO deposits (user_id, method, amount, usd_amount, status, stars_count, locked_until)
     VALUES ($1, 'stars', $2, $2, 'pending', $3, $4)`,
    [userId, usdAmount, starsCount, lockedUntil]
  );

  return { lockedUntil, usdAmount };
}

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
    await adjustBalance(dep.user_id, parseFloat(dep.usd_amount), 0, "deposit", `Stars deposit (${dep.stars_count} ⭐)`, String(dep.id));
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

  const commission = amount * 0.05; // 5% of first deposit
  await adjustBalance(user.referral_id, commission, 0, "referral", `Referral commission from user ${userId} first deposit`);
  await query(
    `INSERT INTO referral_earnings (referrer_id, referee_id, tier, amount, source_type)
     VALUES ($1, $2, 1, $3, 'deposit')`,
    [user.referral_id, userId, commission]
  );

  // Update total deposited
  await query(
    "UPDATE bot_users SET total_deposited = total_deposited + $1, updated_at=NOW() WHERE id=$2",
    [amount, userId]
  );
}

export async function getDepositHistory(userId: number, limit = 10): Promise<DepositRecord[]> {
  const result = await query(
    "SELECT * FROM deposits WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit]
  );
  return result.rows;
}
