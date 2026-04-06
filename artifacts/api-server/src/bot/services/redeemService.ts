import { query, withTransaction } from "../db";
import { adjustBalance } from "./userService";

const BOT_USERNAME = process.env.BOT_USERNAME || "RaizoPvPBot";
const REQUIRED_CHANNELS = ["@RaizoGames", "@RaizoGamesPvP"];

export interface BonusCode {
  id: number;
  code: string;
  amount: number;
  max_uses: number;
  uses_count: number;
  created_by: number;
  expires_at?: Date;
  created_at: Date;
}

// Check if user is subscribed to all required channels
export async function checkChannelSubscriptions(
  bot: import("node-telegram-bot-api"),
  userId: number
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const channel of REQUIRED_CHANNELS) {
    try {
      const member = await bot.getChatMember(channel, userId);
      if (["left", "kicked", "banned"].includes(member.status)) {
        missing.push(channel);
      }
    } catch {
      missing.push(channel); // can't read = not subscribed
    }
  }
  return { ok: missing.length === 0, missing };
}

// Check if user's name or bio includes bot username
export async function checkBotUsernameInProfile(
  bot: import("node-telegram-bot-api"),
  userId: number
): Promise<boolean> {
  try {
    const chat = await bot.getChat(userId);
    const botName = BOT_USERNAME.toLowerCase().replace("@", "");
    const bio = (chat.bio || "").toLowerCase();
    const firstName = ((chat as { first_name?: string }).first_name || "").toLowerCase();
    const lastName = ((chat as { last_name?: string }).last_name || "").toLowerCase();
    return bio.includes(botName) || firstName.includes(botName) || lastName.includes(botName);
  } catch {
    return false;
  }
}

// Admin: create a bonus code
export async function createBonusCode(
  code: string,
  amount: number,
  maxUses: number,
  createdBy: number,
  expiresInDays?: number
): Promise<BonusCode | null> {
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000)
    : null;
  try {
    const r = await query(
      `INSERT INTO bonus_codes (code, amount, max_uses, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [code.toUpperCase(), amount, maxUses, createdBy, expiresAt]
    );
    return r.rows[0];
  } catch {
    return null; // duplicate code
  }
}

// User: redeem a bonus code — returns credited amount or error reason
export async function redeemCode(
  userId: number,
  rawCode: string
): Promise<{ ok: boolean; amount?: number; reason?: string }> {
  const code = rawCode.trim().toUpperCase();

  const codeRes = await query(
    "SELECT * FROM bonus_codes WHERE code=$1",
    [code]
  );
  const bc = codeRes.rows[0] as BonusCode | undefined;
  if (!bc) return { ok: false, reason: "Invalid code. Double-check and try again." };

  if (bc.expires_at && new Date(bc.expires_at) < new Date()) {
    return { ok: false, reason: "This code has expired." };
  }

  if (bc.uses_count >= bc.max_uses) {
    return { ok: false, reason: "This code has reached its maximum uses." };
  }

  // Check if user already used it
  const usedRes = await query(
    "SELECT 1 FROM bonus_code_uses WHERE code_id=$1 AND user_id=$2",
    [bc.id, userId]
  );
  if (usedRes.rows.length > 0) {
    return { ok: false, reason: "You have already redeemed this code." };
  }

  // Credit bonus balance + record use
  await withTransaction(async (client) => {
    await client.query(
      "INSERT INTO bonus_code_uses (code_id, user_id) VALUES ($1, $2)",
      [bc.id, userId]
    );
    await client.query(
      "UPDATE bonus_codes SET uses_count = uses_count + 1 WHERE id=$1",
      [bc.id]
    );
  });

  await adjustBalance(userId, 0, bc.amount, "bonus", `Bonus code: ${code}`);

  return { ok: true, amount: bc.amount };
}

export async function getBonusCodes(): Promise<BonusCode[]> {
  const r = await query("SELECT * FROM bonus_codes ORDER BY created_at DESC LIMIT 50");
  return r.rows;
}

export async function deleteBonusCode(code: string): Promise<boolean> {
  const r = await query("DELETE FROM bonus_codes WHERE code=$1 RETURNING id", [code.toUpperCase()]);
  return r.rowCount! > 0;
}
