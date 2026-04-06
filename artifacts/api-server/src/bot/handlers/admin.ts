import TelegramBot from "node-telegram-bot-api";
import { query } from "../db";
import { getUser, adjustBalance } from "../services/userService";
import { approveWithdrawal, rejectWithdrawal, getPendingWithdrawals } from "../services/withdrawService";
import { getHouseProfitDashboard, setSetting, getSettings } from "../services/riskService";
import { formatUSD, formatDate, b, i, code, escapeHtml } from "../utils";

const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID || "2139807311");

export function isAdmin(userId: number): boolean {
  return userId === ADMIN_ID;
}

export async function handleAdminPanel(bot: TelegramBot, chatId: number): Promise<void> {
  const stats = await query(
    `SELECT 
      COUNT(*) as total_users,
      SUM(total_deposited) as total_deposits,
      SUM(total_withdrawn) as total_withdrawn,
      SUM(total_wagered) as total_wagered
     FROM bot_users WHERE is_banned=FALSE`
  );

  const pendingWithdrawals = await query(
    "SELECT COUNT(*) as cnt, SUM(net_amount) as total FROM withdrawals WHERE status='pending'"
  );

  const s = stats.rows[0];
  const pw = pendingWithdrawals.rows[0];

  let text = `👑 ${b("RAIZO GAMES Admin Panel")}\n\n`;
  text += `👥 Total Users: ${s.total_users}\n`;
  text += `💰 Total Deposited: ${formatUSD(parseFloat(s.total_deposits || "0"))}\n`;
  text += `💸 Total Withdrawn: ${formatUSD(parseFloat(s.total_withdrawn || "0"))}\n`;
  text += `🎲 Total Wagered: ${formatUSD(parseFloat(s.total_wagered || "0"))}\n`;
  text += `⏳ Pending Withdrawals: ${pw.cnt} (${formatUSD(parseFloat(pw.total || "0"))})\n`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Profit Dashboard", callback_data: "admin_profit" },
          { text: "💸 Pending Withdrawals", callback_data: "admin_pending_withdrawals" },
        ],
        [
          { text: "🔍 User Lookup", callback_data: "admin_user_lookup" },
          { text: "⚙️ Risk Settings", callback_data: "admin_risk_settings" },
        ],
        [
          { text: "📋 Recent Games", callback_data: "admin_recent_games" },
          { text: "🚨 Top Winners", callback_data: "admin_top_winners" },
        ],
      ],
    },
  });
}

export async function handleAdminProfit(bot: TelegramBot, chatId: number): Promise<void> {
  const dash = await getHouseProfitDashboard();
  const today = dash.today;
  const all = dash.allTime;

  let text = `📊 ${b("Profit Dashboard")}\n\n`;
  text += `${b("Today:")}\n`;
  text += `• Wagered: ${formatUSD(parseFloat(today.total_wagered || "0"))}\n`;
  text += `• Paid Out: ${formatUSD(parseFloat(today.total_paid_out || "0"))}\n`;
  text += `• GGR: ${formatUSD(parseFloat(today.ggr || "0"))}\n`;
  text += `• Deposits: ${formatUSD(parseFloat(today.total_deposits || "0"))}\n`;
  text += `• Withdrawals: ${formatUSD(parseFloat(today.total_withdrawals || "0"))}\n\n`;
  text += `${b("All Time:")}\n`;
  text += `• Total Wagered: ${formatUSD(parseFloat(all.total_wagered || "0"))}\n`;
  text += `• Total Paid Out: ${formatUSD(parseFloat(all.total_paid_out || "0"))}\n`;
  text += `• GGR: ${formatUSD(parseFloat(all.ggr || "0"))}\n`;
  text += `• NGR: ${formatUSD(parseFloat(all.ggr || "0") - parseFloat(all.bonus_cost || "0"))}\n\n`;

  if (dash.topWinners.length > 0) {
    text += `🏆 ${b("Top Winners (24h):")}\n`;
    for (const w of dash.topWinners) {
      const name = escapeHtml(w.username ? `@${w.username}` : w.first_name || `#${w.id}`);
      text += `• ${name}: ${formatUSD(parseFloat(w.winnings_24h))}\n`;
    }
  }

  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}

export async function handleAdminPendingWithdrawals(bot: TelegramBot, chatId: number): Promise<void> {
  const pending = await getPendingWithdrawals();

  if (pending.length === 0) {
    await bot.sendMessage(chatId, "✅ No pending withdrawals.");
    return;
  }

  for (const w of pending.slice(0, 5)) {
    const wu = w as unknown as { username?: string; first_name?: string };
    const name = escapeHtml(wu.username ? `@${wu.username}` : wu.first_name || `#${w.user_id}`);

    const text = `💸 ${b("Withdrawal Request #" + w.id)}\n\n`
      + `User: ${name}\n`
      + `Amount: ${formatUSD(parseFloat(String(w.net_amount)))} (fee: ${formatUSD(parseFloat(String(w.fee)))})\n`
      + `Address: ${code(w.address)}\n`
      + `Requested: ${i(formatDate(new Date(w.created_at)))}`;

    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `admin_approve_${w.id}` },
            { text: "❌ Reject", callback_data: `admin_reject_${w.id}` },
          ],
        ],
      },
    });
  }
}

export async function handleAdminApproveWithdrawal(bot: TelegramBot, chatId: number, withdrawId: number): Promise<void> {
  const ok = await approveWithdrawal(withdrawId);
  if (!ok) {
    await bot.sendMessage(chatId, `❌ Withdrawal #${withdrawId} not found or already processed.`);
    return;
  }

  const w = await query("SELECT * FROM withdrawals WHERE id=$1", [withdrawId]);
  const withdrawal = w.rows[0];

  await bot.sendMessage(chatId,
    `✅ Withdrawal #${withdrawId} ${b("APPROVED")}\nAmount: ${formatUSD(parseFloat(withdrawal.net_amount))}\nAddress: ${code(withdrawal.address)}`,
    { parse_mode: "HTML" }
  );

  try {
    await bot.sendMessage(withdrawal.user_id,
      `✅ ${b("Withdrawal Approved!")}\n\nYour withdrawal of ${b(formatUSD(parseFloat(withdrawal.net_amount)))} USDT has been approved!\nProcessing to: ${code(withdrawal.address)}`,
      { parse_mode: "HTML" }
    );
  } catch { /* user may have blocked bot */ }
}

export async function handleAdminRejectWithdrawal(bot: TelegramBot, chatId: number, withdrawId: number): Promise<void> {
  const ok = await rejectWithdrawal(withdrawId, "Rejected by admin");
  if (!ok) {
    await bot.sendMessage(chatId, `❌ Withdrawal #${withdrawId} not found or already processed.`);
    return;
  }

  await bot.sendMessage(chatId, `❌ Withdrawal #${withdrawId} ${b("REJECTED")} — funds refunded to user.`, { parse_mode: "HTML" });

  const w = await query("SELECT * FROM withdrawals WHERE id=$1", [withdrawId]);
  const withdrawal = w.rows[0];
  try {
    await bot.sendMessage(withdrawal.user_id,
      `❌ ${b("Withdrawal Rejected")}\n\nYour withdrawal of ${formatUSD(parseFloat(withdrawal.amount))} USDT was rejected and refunded to your balance.`,
      { parse_mode: "HTML" }
    );
  } catch { /* user may have blocked bot */ }
}

export async function handleAdminUserLookup(bot: TelegramBot, chatId: number): Promise<void> {
  await bot.sendMessage(chatId, "🔍 Enter user ID or username to look up:", {
    reply_markup: { force_reply: true, input_field_placeholder: "User ID or username (without @)" },
  });
}

export async function handleAdminUserDetail(bot: TelegramBot, chatId: number, search: string): Promise<void> {
  let userRes;
  const id = parseInt(search.replace("@", ""));
  if (!isNaN(id)) {
    userRes = await query("SELECT * FROM bot_users WHERE id=$1", [id]);
  } else {
    userRes = await query("SELECT * FROM bot_users WHERE username=$1", [search.replace("@", "")]);
  }

  if (!userRes.rows[0]) {
    await bot.sendMessage(chatId, "❌ User not found.");
    return;
  }

  const user = userRes.rows[0];
  const text = `👤 ${b("User #" + user.id)}\n\n`
    + `Name: ${escapeHtml((user.first_name || "") + " " + (user.last_name || ""))}\n`
    + `Username: ${user.username ? escapeHtml("@" + user.username) : "none"}\n`
    + `Balance: ${formatUSD(parseFloat(user.real_balance))}\n`
    + `Bonus: ${formatUSD(parseFloat(user.bonus_balance))}\n`
    + `Deposited: ${formatUSD(parseFloat(user.total_deposited))}\n`
    + `Wagered: ${formatUSD(parseFloat(user.total_wagered))}\n`
    + `Withdrawn: ${formatUSD(parseFloat(user.total_withdrawn))}\n`
    + `VIP: ${user.is_vip ? "Yes" : "No"}\n`
    + `Banned: ${user.is_banned ? "Yes" : "No"}\n`
    + `Joined: ${i(formatDate(new Date(user.created_at)))}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ Add Balance", callback_data: `admin_add_balance_${user.id}` },
          { text: "➖ Remove Balance", callback_data: `admin_remove_balance_${user.id}` },
        ],
        [
          { text: user.is_banned ? "✅ Unban" : "🚫 Ban", callback_data: `admin_ban_${user.id}` },
          { text: user.is_vip ? "⬇️ Remove VIP" : "💎 Make VIP", callback_data: `admin_vip_${user.id}` },
        ],
      ],
    },
  });
}

export async function handleAdminRiskSettings(bot: TelegramBot, chatId: number): Promise<void> {
  const settings = await getSettings();

  let text = `⚙️ ${b("Risk Settings")}\n\n`;
  const important = ["house_edge_dice", "house_edge_slots", "bot_lose_rate", "max_daily_payout", "force_pvp_above", "wager_multiplier"];

  for (const key of important) {
    text += `• ${key}: ${b(settings[key] || "N/A")}\n`;
  }

  text += `\n${i("Use commands to change settings:")}\n`;
  text += `${code("/set house_edge_dice 55")}\n`;
  text += `${code("/set bot_lose_rate 20")}\n`;
  text += `${code("/set max_daily_payout 500")}\n`;
  text += `${code("/set force_pvp_above 10")}\n`;

  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}

export async function handleAdminBanUser(bot: TelegramBot, chatId: number, targetId: number): Promise<void> {
  const user = await getUser(targetId);
  if (!user) return;

  const newStatus = !user.is_banned;
  await query("UPDATE bot_users SET is_banned=$1 WHERE id=$2", [newStatus, targetId]);
  await bot.sendMessage(chatId, `${newStatus ? "🚫 User banned" : "✅ User unbanned"}: #${targetId}`);
}

export async function handleAdminSetSetting(bot: TelegramBot, chatId: number, key: string, value: string): Promise<void> {
  await setSetting(key, value);
  await bot.sendMessage(chatId, `✅ Setting updated: ${b(key)} = ${code(value)}`, { parse_mode: "HTML" });
}

export async function handleAdminRecentGames(bot: TelegramBot, chatId: number): Promise<void> {
  const games = await query(
    `SELECT gb.*, u.username, u.first_name 
     FROM game_bets gb JOIN bot_users u ON gb.creator_id = u.id
     WHERE gb.status='completed'
     ORDER BY gb.completed_at DESC LIMIT 10`
  );

  if (!games.rows.length) {
    await bot.sendMessage(chatId, "No completed games yet.");
    return;
  }

  let text = `🎮 ${b("Recent Games")}\n\n`;
  for (const g of games.rows) {
    text += `• #${g.id} ${g.game_type} (${g.mode}): ${formatUSD(parseFloat(g.bet_amount))} — Winner: ${g.winner_id ? `#${g.winner_id}` : "Draw"}\n`;
  }
  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}

export async function handleAdminTopWinners(bot: TelegramBot, chatId: number): Promise<void> {
  const winners = await query(
    `SELECT u.id, u.username, u.first_name,
            SUM(gb.payout) as total_won,
            COUNT(*) as win_count
     FROM game_bets gb
     JOIN bot_users u ON gb.winner_id = u.id
     WHERE gb.completed_at > NOW() - INTERVAL '24 hours' AND gb.winner_id IS NOT NULL
     GROUP BY u.id, u.username, u.first_name
     ORDER BY total_won DESC LIMIT 10`
  );

  if (!winners.rows.length) {
    await bot.sendMessage(chatId, "No big winners in the last 24h.");
    return;
  }

  let text = `🚨 ${b("Top Winners (24h)")}\n\n`;
  for (const w of winners.rows) {
    const name = escapeHtml(w.username ? `@${w.username}` : w.first_name || `#${w.id}`);
    text += `• ${name}: ${b(formatUSD(parseFloat(w.total_won)))} (${w.win_count} wins)\n`;
  }
  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}
