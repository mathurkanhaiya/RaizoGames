import { query } from "../db";
import { adjustBalance } from "./userService";

const BOT_USERNAME = (process.env.BOT_USERNAME || "RaizoPvPBot").toLowerCase().replace("@", "");

// Check if user's name or bio includes the bot username
export async function checkBotUsernameInProfile(
  bot: import("node-telegram-bot-api"),
  userId: number
): Promise<boolean> {
  try {
    const chat = await bot.getChat(userId);
    const bio = ((chat as { bio?: string }).bio || "").toLowerCase();
    const firstName = ((chat as { first_name?: string }).first_name || "").toLowerCase();
    const lastName = ((chat as { last_name?: string }).last_name || "").toLowerCase();
    return bio.includes(BOT_USERNAME) || firstName.includes(BOT_USERNAME) || lastName.includes(BOT_USERNAME);
  } catch {
    return false;
  }
}

// Random amount between min and max (2 decimals)
function randomBonus(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

export async function claimDaily(
  userId: number
): Promise<{ ok: boolean; amount?: number; nextClaimMs?: number; reason?: string }> {
  const user = await query("SELECT last_daily_claim FROM bot_users WHERE id=$1", [userId]);
  const row = user.rows[0];
  if (!row) return { ok: false, reason: "User not found." };

  const cooldown = 24 * 60 * 60 * 1000; // 24 hours
  if (row.last_daily_claim) {
    const elapsed = Date.now() - new Date(row.last_daily_claim).getTime();
    if (elapsed < cooldown) {
      return { ok: false, nextClaimMs: cooldown - elapsed, reason: "Already claimed today." };
    }
  }

  const amount = randomBonus(0.01, 0.05);
  await query("UPDATE bot_users SET last_daily_claim=NOW(), updated_at=NOW() WHERE id=$1", [userId]);
  await adjustBalance(userId, 0, amount, "daily_bonus", "Daily bonus claim");

  return { ok: true, amount };
}

export async function claimWeekly(
  userId: number
): Promise<{ ok: boolean; amount?: number; nextClaimMs?: number; reason?: string }> {
  const user = await query("SELECT last_weekly_claim FROM bot_users WHERE id=$1", [userId]);
  const row = user.rows[0];
  if (!row) return { ok: false, reason: "User not found." };

  const cooldown = 7 * 24 * 60 * 60 * 1000; // 7 days
  if (row.last_weekly_claim) {
    const elapsed = Date.now() - new Date(row.last_weekly_claim).getTime();
    if (elapsed < cooldown) {
      return { ok: false, nextClaimMs: cooldown - elapsed, reason: "Already claimed this week." };
    }
  }

  const amount = randomBonus(0.01, 0.05);
  await query("UPDATE bot_users SET last_weekly_claim=NOW(), updated_at=NOW() WHERE id=$1", [userId]);
  await adjustBalance(userId, 0, amount, "weekly_bonus", "Weekly bonus claim");

  return { ok: true, amount };
}

// Format ms remaining into human-readable string
export function formatTimeLeft(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const h = hours % 24;
    return `${days}d ${h}h ${minutes}m`;
  }
  return `${hours}h ${minutes}m`;
}
