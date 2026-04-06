/**
 * Game log service — sends formatted game results to @raizologs channel
 * Bot must be admin in the channel for this to work.
 */
import TelegramBot from "node-telegram-bot-api";
import { b, i, escapeHtml, formatUSD, getGameEmoji } from "../utils";

const LOG_CHANNEL = process.env.LOG_CHANNEL || "@raizologs";

let _bot: TelegramBot | null = null;

export function initLogService(bot: TelegramBot): void {
  _bot = bot;
}

export async function sendGameLog(params: {
  gameType: string;
  mode: "bot" | "pvp";
  betAmount: number;
  creatorId: number;
  creatorName: string;
  opponentId?: number;
  opponentName?: string;
  creatorResult: string;
  opponentResult: string;
  winnerId: number | null;
  winnerName?: string;
  payout: number;
  houseFee: number;
}): Promise<void> {
  if (!_bot) return;

  const {
    gameType, mode, betAmount, creatorId, creatorName,
    opponentId, opponentName, creatorResult, opponentResult,
    winnerId, winnerName, payout, houseFee,
  } = params;

  const emoji = getGameEmoji(gameType);
  const gameLabel = gameType.charAt(0).toUpperCase() + gameType.slice(1);
  const modeLabel = mode === "pvp" ? "⚔️ PvP" : "🤖 vs Bot";

  let outcome = "";
  if (winnerId === null) {
    outcome = `🤝 ${b("DRAW")} — Both refunded`;
  } else if (winnerId < 0) {
    outcome = `🏠 ${b("HOUSE WINS")} — ${escapeHtml(creatorName)} lost ${formatUSD(betAmount)}`;
  } else {
    const net = payout - betAmount;
    outcome = `🏆 ${b(escapeHtml(winnerName || `#${winnerId}`))} wins ${formatUSD(payout)} (+${formatUSD(net)})`;
  }

  let text = `${emoji} ${b("RAIZO GAMES")} — ${gameLabel} | ${modeLabel}\n`;
  text += `━━━━━━━━━━━━━━\n`;
  text += `👤 ${b(escapeHtml(creatorName))} (#${creatorId}): ${creatorResult}\n`;
  if (mode === "pvp" && opponentName) {
    text += `👤 ${b(escapeHtml(opponentName))} (#${opponentId}): ${opponentResult}\n`;
  } else if (mode === "bot") {
    text += `🤖 Bot: ${opponentResult}\n`;
  }
  text += `\n💰 Bet: ${formatUSD(betAmount)}`;
  if (mode === "pvp") text += ` each`;
  text += `\n${outcome}\n`;
  if (houseFee > 0) text += `${i("House fee: " + formatUSD(houseFee))}`;

  try {
    await _bot.sendMessage(LOG_CHANNEL, text, { parse_mode: "HTML" });
  } catch {
    // Channel not found or bot not admin — silently ignore
  }
}
