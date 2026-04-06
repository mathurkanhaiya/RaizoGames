import { query } from "../db";
import { adjustBalance, getUser } from "./userService";
import { calcWithdrawFee } from "../utils";
import { recordWithdrawal, getSettingNum } from "./riskService";

export interface WithdrawRecord {
  id: number;
  user_id: number;
  amount: number;
  fee: number;
  net_amount: number;
  address: string;
  network: string;
  status: string;
  admin_note?: string;
  created_at: Date;
  processed_at?: Date;
}

export async function canWithdraw(userId: number): Promise<{ ok: boolean; reason?: string }> {
  const user = await getUser(userId);
  if (!user) return { ok: false, reason: "User not found" };

  // Must have at least one confirmed real deposit to withdraw
  const depCheck = await query(
    "SELECT 1 FROM deposits WHERE user_id=$1 AND status='confirmed' AND method != 'bonus' LIMIT 1",
    [userId]
  );
  if (depCheck.rows.length === 0) {
    return { ok: false, reason: "You must make at least one USDT or Stars deposit before withdrawing." };
  }

  const minWithdraw = await getSettingNum("min_withdraw", 0.5);

  if (user.real_balance < minWithdraw) {
    return { ok: false, reason: `Minimum withdrawal is $${minWithdraw} USDT. Your balance: $${parseFloat(String(user.real_balance)).toFixed(4)}` };
  }

  if (user.last_withdraw_at) {
    const cooldownHours = 24;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const timeSinceLast = Date.now() - new Date(user.last_withdraw_at).getTime();
    if (timeSinceLast < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - timeSinceLast) / 3600000);
      return { ok: false, reason: `Withdrawal cooldown active. Wait ${remaining} more hour(s).` };
    }
  }

  const wagerMultiplier = await getSettingNum("wager_multiplier", 2);
  const wagerReq = parseFloat(String(user.wager_requirement));
  if (wagerReq > 0) {
    return { ok: false, reason: `You need to wager $${wagerReq.toFixed(4)} more before withdrawing. (${wagerMultiplier}x deposit wager requirement)` };
  }

  return { ok: true };
}

export async function requestWithdrawal(
  userId: number,
  amount: number,
  address: string
): Promise<{ ok: boolean; withdrawal?: WithdrawRecord; reason?: string }> {
  const check = await canWithdraw(userId);
  if (!check.ok) return { ok: false, reason: check.reason };

  const user = await getUser(userId);
  if (!user || user.real_balance < amount) {
    return { ok: false, reason: "Insufficient balance" };
  }

  const fee = calcWithdrawFee(amount);
  const netAmount = amount - fee;

  // Deduct from balance (hold in pending)
  await adjustBalance(userId, -amount, 0, "withdraw", `Withdrawal request - pending approval`, String(Date.now()));

  // Update last_withdraw_at
  await query(
    "UPDATE bot_users SET last_withdraw_at=NOW(), updated_at=NOW() WHERE id=$1",
    [userId]
  );

  const result = await query(
    `INSERT INTO withdrawals (user_id, amount, fee, net_amount, address)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, amount, fee, netAmount, address]
  );

  return { ok: true, withdrawal: result.rows[0] };
}

export async function approveWithdrawal(withdrawId: number, adminNote?: string): Promise<boolean> {
  const result = await query(
    "SELECT * FROM withdrawals WHERE id=$1 AND status='pending'",
    [withdrawId]
  );
  const withdraw = result.rows[0];
  if (!withdraw) return false;

  await query(
    "UPDATE withdrawals SET status='approved', admin_note=$1, processed_at=NOW() WHERE id=$2",
    [adminNote || null, withdrawId]
  );

  await recordWithdrawal(parseFloat(withdraw.net_amount));
  return true;
}

export async function rejectWithdrawal(withdrawId: number, adminNote?: string): Promise<boolean> {
  const result = await query(
    "SELECT * FROM withdrawals WHERE id=$1 AND status='pending'",
    [withdrawId]
  );
  const withdraw = result.rows[0];
  if (!withdraw) return false;

  // Refund user
  await adjustBalance(withdraw.user_id, parseFloat(withdraw.amount), 0, "refund", `Withdrawal #${withdrawId} rejected: ${adminNote || "rejected by admin"}`);

  await query(
    "UPDATE withdrawals SET status='rejected', admin_note=$1, processed_at=NOW() WHERE id=$2",
    [adminNote || null, withdrawId]
  );

  return true;
}

export async function getPendingWithdrawals(): Promise<WithdrawRecord[]> {
  const result = await query(
    `SELECT w.*, u.username, u.first_name 
     FROM withdrawals w JOIN bot_users u ON w.user_id = u.id
     WHERE w.status='pending' ORDER BY w.created_at ASC`
  );
  return result.rows;
}

export async function getWithdrawHistory(userId: number, limit = 10): Promise<WithdrawRecord[]> {
  const result = await query(
    "SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit]
  );
  return result.rows;
}
