import TelegramBot from "node-telegram-bot-api";
import { getUser } from "../services/userService";
import { getDepositHistory } from "../services/depositService";
import { getWithdrawHistory } from "../services/withdrawService";
import { getUserBetHistory } from "../services/gameService";
import { formatUSD, formatDate, b, i, getGameEmoji } from "../utils";
import { walletKeyboard } from "./keyboard";
import { query } from "../db";

export async function handleBalance(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const userId = msg.from!.id;

  const user = await getUser(userId);
  if (!user) {
    await bot.sendMessage(chatId, "Please start the bot first with /start");
    return;
  }

  const real = parseFloat(String(user.real_balance));
  const bonus = parseFloat(String(user.bonus_balance));
  const wagerReq = parseFloat(String(user.wager_requirement));
  const bonusWagerReq = parseFloat(String(user.bonus_wager_requirement));
  const totalDeposited = parseFloat(String(user.total_deposited));
  const totalWagered = parseFloat(String(user.total_wagered));
  const totalWithdrawn = parseFloat(String(user.total_withdrawn));

  // Game stats
  const statsRes = await query(
    `SELECT 
      COUNT(*)::int as total_games,
      COUNT(*) FILTER (WHERE winner_id=$1)::int as wins,
      COUNT(*) FILTER (WHERE status='completed' AND winner_id IS NULL)::int as draws
     FROM game_bets
     WHERE (creator_id=$1 OR opponent_id=$1) AND status='completed'`,
    [userId]
  );
  const stats = statsRes.rows[0];
  const totalGames = parseInt(stats?.total_games || "0");
  const wins = parseInt(stats?.wins || "0");
  const losses = Math.max(0, totalGames - wins - parseInt(stats?.draws || "0"));

  let text = `💰 ${b("Your Wallet — RAIZO GAMES")}\n\n`;
  text += `💵 ${b("Real Balance:")} ${formatUSD(real)}\n`;
  if (bonus > 0) text += `🎁 ${b("Bonus:")} ${formatUSD(bonus)}\n`;

  text += `\n📊 ${b("Lifetime Stats:")}\n`;
  text += `• Deposited: ${formatUSD(totalDeposited)}\n`;
  text += `• Wagered: ${formatUSD(totalWagered)}\n`;
  text += `• Withdrawn: ${formatUSD(totalWithdrawn)}\n`;
  text += `• Net P&amp;L: ${formatUSD(real + totalWithdrawn - totalDeposited)}\n`;

  text += `\n🎮 ${b("Games:")}\n`;
  text += `• Played: ${totalGames} | Won: ${wins} | Lost: ${losses}\n`;
  if (user.win_streak > 1) text += `• 🔥 Win Streak: ${user.win_streak}\n`;

  if (wagerReq > 0) text += `\n⚠️ ${b("Wager Requirement:")} ${formatUSD(wagerReq)} remaining\n`;
  if (bonusWagerReq > 0) text += `🎁 ${b("Bonus Wager Req:")} ${formatUSD(bonusWagerReq)} remaining\n`;
  if (user.is_vip) text += `\n💎 ${b("VIP Status:")} Active\n`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: walletKeyboard(),
  });
}

export async function handleTransactionHistory(
  bot: TelegramBot,
  chatId: number,
  userId: number
): Promise<void> {
  const [deposits, withdrawals, games] = await Promise.all([
    getDepositHistory(userId, 10),
    getWithdrawHistory(userId, 10),
    getUserBetHistory(userId, 10),
  ]);

  let text = `🧾 ${b("Full Transaction History")}\n\n`;

  // ── Deposits ──────────────────────────────────────────────────────────────
  text += `${b("📥 Deposits:")}\n`;
  if (deposits.length > 0) {
    for (const dep of deposits) {
      const icon = dep.status === "confirmed" ? "✅"
        : dep.status === "refunded" ? "↩️"
        : dep.status === "pending" ? "⏳" : "❌";
      const method = dep.method === "stars"
        ? `⭐ ${dep.stars_count} Stars`
        : dep.method.toUpperCase();
      const usd = parseFloat(String(dep.usd_amount));
      text += `${icon} ${method} — ${formatUSD(usd)}`;
      if (dep.status === "pending" && dep.locked_until) {
        const days = Math.max(0, Math.ceil(
          (new Date(dep.locked_until).getTime() - Date.now()) / (86400 * 1000)
        ));
        text += ` ${i("(unlocks in " + days + "d)")}`;
      }
      text += `\n   ${i(formatDate(new Date(dep.created_at)))}\n`;
    }
  } else {
    text += `${i("No deposits yet.")}\n`;
  }

  // ── Withdrawals ───────────────────────────────────────────────────────────
  text += `\n${b("📤 Withdrawals:")}\n`;
  if (withdrawals.length > 0) {
    for (const w of withdrawals) {
      const icon = w.status === "approved" ? "✅" : w.status === "rejected" ? "❌" : "⏳";
      const net = parseFloat(String(w.net_amount));
      const fee = parseFloat(String(w.fee));
      text += `${icon} ${formatUSD(net)} ${i("(fee " + formatUSD(fee) + ")")} — ${w.status}\n`;
      text += `   ${i(formatDate(new Date(w.created_at)))}\n`;
    }
  } else {
    text += `${i("No withdrawals yet.")}\n`;
  }

  // ── Game History ──────────────────────────────────────────────────────────
  text += `\n${b("🎮 Recent Games:")}\n`;
  if (games.length > 0) {
    for (const g of games) {
      const isCreator = g.creator_id === userId;
      const myResult = isCreator ? g.creator_result : g.opponent_result;
      const theirResult = isCreator ? g.opponent_result : g.creator_result;
      const betAmt = parseFloat(String(g.bet_amount));
      const payout = parseFloat(String(g.payout));

      let icon = "🤝";
      let resultLine = "Draw";
      if (g.winner_id === userId) {
        icon = "🏆";
        resultLine = `+${formatUSD(payout - betAmt)}`;
      } else if (g.winner_id !== null) {
        icon = "💀";
        resultLine = `-${formatUSD(betAmt)}`;
      }

      const gameEmoji = getGameEmoji(g.game_type);
      const modeTag = g.mode === "pvp" ? "PvP" : "Bot";
      text += `${icon} ${gameEmoji} ${g.game_type} (${modeTag}) — ${resultLine}\n`;
      if (myResult) text += `   You: ${myResult}`;
      if (theirResult) text += ` | Opp: ${theirResult}`;
      if (myResult || theirResult) text += "\n";
      if (g.completed_at) text += `   ${i(formatDate(new Date(g.completed_at)))}\n`;
    }
  } else {
    text += `${i("No games played yet.")}\n`;
  }

  // Telegram has a 4096 char limit — truncate if needed
  if (text.length > 3900) {
    text = text.substring(0, 3900) + "\n…";
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "« Back to Wallet", callback_data: "back_wallet" }],
      ],
    },
  });
}
