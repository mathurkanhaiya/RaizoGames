import { query, withTransaction } from "../db";
import { generateReferralCode } from "../utils";

export interface BotUser {
  id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  real_balance: number;
  bonus_balance: number;
  total_wagered: number;
  total_deposited: number;
  total_withdrawn: number;
  referral_id: number | null;
  referral_code: string;
  is_vip: boolean;
  is_banned: boolean;
  newbie_bonus_given: boolean;
  wager_requirement: number;
  bonus_wager_requirement: number;
  last_withdraw_at: Date | null;
  win_streak: number;
  loss_streak: number;
  consecutive_bot_losses: number;
  created_at: Date;
}

export async function getOrCreateUser(
  telegramId: number,
  username?: string,
  firstName?: string,
  lastName?: string,
  referralCode?: string
): Promise<BotUser> {
  const existing = await query(
    "SELECT * FROM bot_users WHERE id = $1",
    [telegramId]
  );

  if (existing.rows.length > 0) {
    // Update username/name if changed
    await query(
      `UPDATE bot_users SET username=$1, first_name=$2, last_name=$3, updated_at=NOW() WHERE id=$4`,
      [username || null, firstName || null, lastName || null, telegramId]
    );
    return { ...existing.rows[0], ...{ username, first_name: firstName, last_name: lastName } };
  }

  // Find referrer
  let referrerId: number | null = null;
  if (referralCode) {
    const refUser = await query(
      "SELECT id FROM bot_users WHERE referral_code = $1",
      [referralCode]
    );
    if (refUser.rows.length > 0) {
      referrerId = refUser.rows[0].id;
    }
  }

  const code = generateReferralCode(telegramId);
  const result = await query(
    `INSERT INTO bot_users (id, username, first_name, last_name, referral_code, referral_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [telegramId, username || null, firstName || null, lastName || null, code, referrerId]
  );

  return result.rows[0];
}

export async function getUser(telegramId: number): Promise<BotUser | null> {
  const result = await query("SELECT * FROM bot_users WHERE id = $1", [telegramId]);
  return result.rows[0] || null;
}

export async function getUserBalance(telegramId: number): Promise<{ real: number; bonus: number }> {
  const result = await query(
    "SELECT real_balance, bonus_balance FROM bot_users WHERE id = $1",
    [telegramId]
  );
  if (!result.rows[0]) return { real: 0, bonus: 0 };
  return {
    real: parseFloat(result.rows[0].real_balance),
    bonus: parseFloat(result.rows[0].bonus_balance),
  };
}

export async function adjustBalance(
  userId: number,
  realDelta: number,
  bonusDelta: number,
  type: string,
  description: string,
  refId?: string
): Promise<void> {
  await withTransaction(async (client) => {
    // Lock the row for this transaction only
    const userRes = await client.query(
      "SELECT real_balance, bonus_balance FROM bot_users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) throw new Error(`User ${userId} not found`);

    const newReal = parseFloat(user.real_balance) + realDelta;
    const newBonus = parseFloat(user.bonus_balance) + bonusDelta;

    if (newReal < -0.0001 || newBonus < -0.0001) {
      throw new Error("Insufficient balance");
    }

    const safeReal = Math.max(0, newReal);
    const safeBonus = Math.max(0, newBonus);

    await client.query(
      `UPDATE bot_users SET real_balance=$1, bonus_balance=$2, updated_at=NOW() WHERE id=$3`,
      [safeReal, safeBonus, userId]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, balance_after, description, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, type, realDelta + bonusDelta, safeReal + safeBonus, description, refId || null]
    );
  });
}

export async function addWagered(userId: number, amount: number): Promise<void> {
  await query(
    `UPDATE bot_users SET 
      total_wagered = total_wagered + $1,
      wager_requirement = GREATEST(0, wager_requirement - $1),
      bonus_wager_requirement = GREATEST(0, bonus_wager_requirement - $1),
      updated_at = NOW()
     WHERE id = $2`,
    [amount, userId]
  );
}

export async function updateStreak(userId: number, won: boolean): Promise<void> {
  if (won) {
    await query(
      "UPDATE bot_users SET win_streak = win_streak + 1, loss_streak = 0, consecutive_bot_losses = 0, updated_at=NOW() WHERE id=$1",
      [userId]
    );
  } else {
    await query(
      "UPDATE bot_users SET loss_streak = loss_streak + 1, win_streak = 0, consecutive_bot_losses = consecutive_bot_losses + 1, updated_at=NOW() WHERE id=$1",
      [userId]
    );
  }
}

export async function getLeaderboard(limit = 10): Promise<BotUser[]> {
  const result = await query(
    `SELECT id, username, first_name, total_wagered, real_balance
     FROM bot_users 
     WHERE is_banned = FALSE
     ORDER BY total_wagered DESC 
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getUserStats(userId: number) {
  const result = await query(
    `SELECT 
      COUNT(DISTINCT gb.id) FILTER (WHERE gb.creator_id = $1 OR gb.opponent_id = $1) as total_games,
      COUNT(DISTINCT gb.id) FILTER (WHERE gb.winner_id = $1) as wins,
      SUM(CASE WHEN gb.winner_id = $1 THEN gb.payout ELSE 0 END) as total_winnings
     FROM game_bets gb
     WHERE (gb.creator_id = $1 OR gb.opponent_id = $1) AND gb.status = 'completed'`,
    [userId]
  );
  return result.rows[0];
}

export async function giveNewbieBonus(userId: number): Promise<number> {
  const user = await getUser(userId);
  if (!user || user.newbie_bonus_given) return 0;

  const bonus = 0.05 + Math.random() * 0.05; // 0.05 to 0.10 USDT
  const roundedBonus = Math.round(bonus * 100) / 100;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await query(
    `UPDATE bot_users SET 
      bonus_balance = bonus_balance + $1,
      bonus_wager_requirement = bonus_wager_requirement + $2,
      newbie_bonus_given = TRUE,
      newbie_bonus_expires_at = $3,
      updated_at = NOW()
     WHERE id = $4`,
    [roundedBonus, roundedBonus * 7, expiresAt, userId]
  );

  await query(
    `INSERT INTO transactions (user_id, type, amount, balance_after, description)
     VALUES ($1, 'bonus', $2, (SELECT real_balance + bonus_balance FROM bot_users WHERE id=$1), 'Newbie bonus')`,
    [userId, roundedBonus]
  );

  return roundedBonus;
}
