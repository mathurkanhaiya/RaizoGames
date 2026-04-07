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

// ─── MAIN PANEL ──────────────────────────────────────────────────────────────

export async function handleAdminPanel(bot: TelegramBot, chatId: number): Promise<void> {
  const stats = await query(
    `SELECT 
      COUNT(*) as total_users,
      COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as new_today,
      COUNT(CASE WHEN is_banned THEN 1 END) as banned_count,
      SUM(total_deposited) as total_deposits,
      SUM(total_withdrawn) as total_withdrawn,
      SUM(total_wagered) as total_wagered
     FROM bot_users`
  );

  const pendingW = await query(
    "SELECT COUNT(*) as cnt, COALESCE(SUM(net_amount),0) as total FROM withdrawals WHERE status='pending'"
  );

  const todayGames = await query(
    "SELECT COUNT(*) as cnt FROM game_bets WHERE status='completed' AND completed_at > NOW() - INTERVAL '24 hours'"
  );

  const todayRevenue = await query(
    "SELECT COALESCE(SUM(house_fee),0) as fee FROM game_bets WHERE status='completed' AND completed_at > NOW() - INTERVAL '24 hours'"
  );

  const s = stats.rows[0];
  const pw = pendingW.rows[0];

  const text =
    `👑 ${b("RAIZO GAMES — Admin Panel")}\n\n`
    + `━━━━━━━━━━━━━━━━━━\n`
    + `👥 ${b("Users:")} ${s.total_users} total · ${s.new_today} new today\n`
    + `🚫 Banned: ${s.banned_count}\n`
    + `━━━━━━━━━━━━━━━━━━\n`
    + `💰 ${b("Deposits:")} ${formatUSD(parseFloat(s.total_deposits || "0"))}\n`
    + `💸 ${b("Withdrawals:")} ${formatUSD(parseFloat(s.total_withdrawn || "0"))}\n`
    + `🎲 ${b("Wagered:")} ${formatUSD(parseFloat(s.total_wagered || "0"))}\n`
    + `━━━━━━━━━━━━━━━━━━\n`
    + `🎮 Games today: ${todayGames.rows[0].cnt}\n`
    + `💹 Revenue today: ${formatUSD(parseFloat(todayRevenue.rows[0].fee))}\n`
    + `━━━━━━━━━━━━━━━━━━\n`
    + `⏳ ${b("Pending Withdrawals:")} ${pw.cnt} · ${formatUSD(parseFloat(pw.total))}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Profit Dashboard", callback_data: "admin_profit" },
          { text: "⚙️ Settings", callback_data: "admin_risk_settings" },
        ],
        [
          { text: "💸 Withdrawals", callback_data: "admin_pending_withdrawals" },
          { text: "🔍 User Lookup", callback_data: "admin_user_lookup" },
        ],
        [
          { text: "🎮 Recent Games", callback_data: "admin_recent_games" },
          { text: "🏆 Top Winners", callback_data: "admin_top_winners" },
        ],
        [
          { text: "🎁 Bonus Codes", callback_data: "admin_bonus_codes" },
          { text: "📋 Active Tasks", callback_data: "admin_view_tasks" },
        ],
        [
          { text: "👥 All Users", callback_data: "admin_all_users" },
          { text: "📢 Broadcast", callback_data: "admin_broadcast" },
        ],
        [{ text: "🔄 Refresh", callback_data: "admin_panel" }],
      ],
    },
  });
}

// ─── PROFIT DASHBOARD ────────────────────────────────────────────────────────

export async function handleAdminProfit(bot: TelegramBot, chatId: number): Promise<void> {
  const dash = await getHouseProfitDashboard();
  const today = dash.today;
  const all = dash.allTime;

  const text =
    `📊 ${b("Profit Dashboard")}\n\n`
    + `${b("━━ Today ━━")}\n`
    + `💰 Wagered: ${formatUSD(parseFloat(today.total_wagered || "0"))}\n`
    + `💸 Paid Out: ${formatUSD(parseFloat(today.total_paid_out || "0"))}\n`
    + `📈 GGR: ${formatUSD(parseFloat(today.ggr || "0"))}\n`
    + `📥 Deposits: ${formatUSD(parseFloat(today.total_deposits || "0"))}\n`
    + `📤 Withdrawals: ${formatUSD(parseFloat(today.total_withdrawals || "0"))}\n\n`
    + `${b("━━ All Time ━━")}\n`
    + `💰 Wagered: ${formatUSD(parseFloat(all.total_wagered || "0"))}\n`
    + `💸 Paid Out: ${formatUSD(parseFloat(all.total_paid_out || "0"))}\n`
    + `📈 GGR: ${formatUSD(parseFloat(all.ggr || "0"))}\n`
    + `📉 NGR: ${formatUSD(parseFloat(all.ggr || "0") - parseFloat(all.bonus_cost || "0"))}\n`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
  });
}

// ─── PENDING WITHDRAWALS ─────────────────────────────────────────────────────

export async function handleAdminPendingWithdrawals(bot: TelegramBot, chatId: number): Promise<void> {
  const pending = await getPendingWithdrawals();

  if (pending.length === 0) {
    await bot.sendMessage(chatId, "✅ No pending withdrawals.", {
      reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
    });
    return;
  }

  for (const w of pending.slice(0, 5)) {
    const wu = w as unknown as { username?: string; first_name?: string };
    const name = escapeHtml(wu.username ? `@${wu.username}` : wu.first_name || `#${w.user_id}`);

    const text =
      `💸 ${b("Withdrawal #" + w.id)}\n\n`
      + `👤 User: ${name} (${code(String(w.user_id))})\n`
      + `💰 Net: ${b(formatUSD(parseFloat(String(w.net_amount))))} (fee: ${formatUSD(parseFloat(String(w.fee)))})\n`
      + `📍 Address: ${code(w.address)}\n`
      + `🕐 Requested: ${i(formatDate(new Date(w.created_at)))}`;

    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `admin_approve_${w.id}` },
            { text: "❌ Reject", callback_data: `admin_reject_${w.id}` },
          ],
          [{ text: "👤 View User", callback_data: `admin_view_user_${w.user_id}` }],
        ],
      },
    });
  }

  if (pending.length > 5) {
    await bot.sendMessage(chatId, `${i("Showing 5 of " + pending.length + " pending withdrawals.")}`, { parse_mode: "HTML" });
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
    `✅ ${b("Approved #" + withdrawId)}\n${formatUSD(parseFloat(withdrawal.net_amount))} → ${code(withdrawal.address)}`,
    { parse_mode: "HTML" }
  );

  try {
    await bot.sendMessage(withdrawal.user_id,
      `✅ ${b("Withdrawal Approved!")}\n\n`
      + `Your withdrawal of ${b(formatUSD(parseFloat(withdrawal.net_amount)))} USDT has been approved!\n`
      + `📍 Address: ${code(withdrawal.address)}\n\n`
      + `${i("Funds are being processed now.")}`,
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

  await bot.sendMessage(chatId, `❌ ${b("Rejected #" + withdrawId)} — funds refunded to user.`, { parse_mode: "HTML" });

  const w = await query("SELECT * FROM withdrawals WHERE id=$1", [withdrawId]);
  const withdrawal = w.rows[0];
  try {
    await bot.sendMessage(withdrawal.user_id,
      `❌ ${b("Withdrawal Rejected")}\n\n`
      + `Your withdrawal of ${formatUSD(parseFloat(withdrawal.amount))} USDT was not processed and has been refunded to your balance.\n\n`
      + `Contact @RaizoGamesSupport if you need help.`,
      { parse_mode: "HTML" }
    );
  } catch { /* user may have blocked bot */ }
}

// ─── USER MANAGEMENT ─────────────────────────────────────────────────────────

export async function handleAdminUserLookup(bot: TelegramBot, chatId: number): Promise<void> {
  await bot.sendMessage(chatId,
    `🔍 ${b("User Lookup")}\n\nEnter a user ID or @username:`,
    {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, input_field_placeholder: "User ID or @username" },
    }
  );
}

export async function handleAdminUserDetail(bot: TelegramBot, chatId: number, search: string): Promise<void> {
  let userRes;
  const clean = search.replace("@", "");
  const id = parseInt(clean);
  if (!isNaN(id) && String(id) === clean) {
    userRes = await query("SELECT * FROM bot_users WHERE id=$1", [id]);
  } else {
    userRes = await query("SELECT * FROM bot_users WHERE username ILIKE $1", [clean]);
  }

  if (!userRes.rows[0]) {
    await bot.sendMessage(chatId, "❌ User not found. Try their numeric ID.");
    return;
  }

  const user = userRes.rows[0];
  await sendUserDetail(bot, chatId, user);
}

export async function handleAdminViewUser(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const userRes = await query("SELECT * FROM bot_users WHERE id=$1", [userId]);
  if (!userRes.rows[0]) {
    await bot.sendMessage(chatId, "❌ User not found.");
    return;
  }
  await sendUserDetail(bot, chatId, userRes.rows[0]);
}

async function sendUserDetail(bot: TelegramBot, chatId: number, user: Record<string, unknown>): Promise<void> {
  const uid = user.id as number;
  const wagerReq = parseFloat(String(user.wager_requirement || "0"));
  const recentGames = await query(
    "SELECT COUNT(*) as cnt FROM game_bets WHERE creator_id=$1 OR opponent_id=$1",
    [uid]
  );

  const text =
    `👤 ${b("User #" + uid)}\n\n`
    + `📛 Name: ${escapeHtml(((user.first_name || "") + " " + (user.last_name || "")).trim() || "N/A")}\n`
    + `🔖 Username: ${user.username ? "@" + escapeHtml(String(user.username)) : "none"}\n`
    + `━━━━━━━━━━━━━━━━━━\n`
    + `💰 Real Balance: ${b(formatUSD(parseFloat(String(user.real_balance))))}\n`
    + `🎁 Bonus Balance: ${formatUSD(parseFloat(String(user.bonus_balance)))}\n`
    + `━━━━━━━━━━━━━━━━━━\n`
    + `📥 Deposited: ${formatUSD(parseFloat(String(user.total_deposited || "0")))}\n`
    + `💸 Withdrawn: ${formatUSD(parseFloat(String(user.total_withdrawn || "0")))}\n`
    + `🎲 Wagered: ${formatUSD(parseFloat(String(user.total_wagered || "0")))}\n`
    + `🎮 Games: ${recentGames.rows[0].cnt}\n`
    + `━━━━━━━━━━━━━━━━━━\n`
    + `💎 VIP: ${user.is_vip ? "Yes" : "No"}\n`
    + `🚫 Banned: ${user.is_banned ? "Yes" : "No"}\n`
    + (wagerReq > 0 ? `⚠️ Wager Req: ${formatUSD(wagerReq)}\n` : "")
    + `📅 Joined: ${i(formatDate(new Date(String(user.created_at))))}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ Add Balance", callback_data: `admin_add_bal_${uid}` },
          { text: "➖ Remove Balance", callback_data: `admin_rm_bal_${uid}` },
        ],
        [
          { text: user.is_banned ? "✅ Unban" : "🚫 Ban", callback_data: `admin_ban_${uid}` },
          { text: user.is_vip ? "⬇️ Remove VIP" : "💎 Grant VIP", callback_data: `admin_vip_${uid}` },
        ],
        [
          { text: "🔄 Reset Wager Req", callback_data: `admin_reset_wager_${uid}` },
          { text: "📊 Game History", callback_data: `admin_user_games_${uid}` },
        ],
        [{ text: "« Admin Panel", callback_data: "admin_panel" }],
      ],
    },
  });
}

export async function handleAdminAllUsers(bot: TelegramBot, chatId: number): Promise<void> {
  const users = await query(
    `SELECT id, username, first_name, real_balance, total_deposited, is_banned, is_vip, created_at
     FROM bot_users ORDER BY created_at DESC LIMIT 15`
  );

  let text = `👥 ${b("Recent Users")}\n\n`;
  for (const u of users.rows) {
    const name = escapeHtml(u.username ? `@${u.username}` : u.first_name || `#${u.id}`);
    const flags = [
      u.is_banned ? "🚫" : "",
      u.is_vip ? "💎" : "",
    ].filter(Boolean).join("");
    text += `• ${name} ${flags} — ${formatUSD(parseFloat(u.real_balance))}\n`;
  }
  text += `\n${i("Showing last 15 users. Use /admin and User Lookup for details.")}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
  });
}

// ─── RISK SETTINGS ───────────────────────────────────────────────────────────

export async function handleAdminRiskSettings(bot: TelegramBot, chatId: number): Promise<void> {
  const settings = await getSettings();

  const keys = [
    ["house_edge_dice", "House Edge (Dice) %"],
    ["house_edge_slots", "House Edge (Slots) %"],
    ["bot_lose_rate", "Bot Lose Rate %"],
    ["max_daily_payout", "Max Daily Payout $"],
    ["force_pvp_above", "Force PvP Above $"],
    ["wager_multiplier", "Wager Multiplier x"],
    ["min_withdraw", "Min Withdraw $"],
  ];

  let text = `⚙️ ${b("Risk & Game Settings")}\n\n`;
  for (const [key, label] of keys) {
    text += `• ${label}: ${b(settings[key] || "N/A")}\n`;
  }
  text += `\n${b("How to change:")}\n${code("/set house_edge_dice 55")}\n${code("/set bot_lose_rate 25")}\n${code("/set max_daily_payout 500")}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
  });
}

// ─── GAME STATS ──────────────────────────────────────────────────────────────

export async function handleAdminRecentGames(bot: TelegramBot, chatId: number): Promise<void> {
  const games = await query(
    `SELECT gb.*, u.username, u.first_name 
     FROM game_bets gb JOIN bot_users u ON gb.creator_id = u.id
     WHERE gb.status='completed'
     ORDER BY gb.completed_at DESC LIMIT 10`
  );

  if (!games.rows.length) {
    await bot.sendMessage(chatId, "No completed games yet.", {
      reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
    });
    return;
  }

  let text = `🎮 ${b("Recent Games")}\n\n`;
  for (const g of games.rows) {
    const name = escapeHtml(g.username ? `@${g.username}` : g.first_name || `#${g.creator_id}`);
    const modeIcon = g.mode === "pvp" ? "⚔️" : "🤖";
    const winner = g.winner_id ? (g.winner_id === g.creator_id ? "Creator" : "Opponent") : "Draw";
    text += `${modeIcon} ${g.game_type} — ${formatUSD(parseFloat(g.bet_amount))} — ${b(winner)}\n`;
    text += `   ${i(name + " · " + formatDate(new Date(g.completed_at)))}\n\n`;
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
  });
}

export async function handleAdminTopWinners(bot: TelegramBot, chatId: number): Promise<void> {
  const winners = await query(
    `SELECT u.id, u.username, u.first_name,
            SUM(gb.payout) as total_won,
            COUNT(*) as win_count
     FROM game_bets gb
     JOIN bot_users u ON gb.winner_id = u.id
     WHERE gb.completed_at > NOW() - INTERVAL '24 hours' AND gb.winner_id IS NOT NULL AND gb.winner_id != -1
     GROUP BY u.id, u.username, u.first_name
     ORDER BY total_won DESC LIMIT 10`
  );

  if (!winners.rows.length) {
    await bot.sendMessage(chatId, "No big winners in the last 24h.", {
      reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
    });
    return;
  }

  let text = `🏆 ${b("Top Winners (24h)")}\n\n`;
  for (let i2 = 0; i2 < winners.rows.length; i2++) {
    const w = winners.rows[i2];
    const name = escapeHtml(w.username ? `@${w.username}` : w.first_name || `#${w.id}`);
    const medal = i2 === 0 ? "🥇" : i2 === 1 ? "🥈" : i2 === 2 ? "🥉" : `${i2 + 1}.`;
    text += `${medal} ${name}: ${b(formatUSD(parseFloat(w.total_won)))} (${w.win_count} wins)\n`;
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
  });
}

// ─── BONUS CODES ─────────────────────────────────────────────────────────────

export async function handleAdminBonusCodes(bot: TelegramBot, chatId: number): Promise<void> {
  const codes = await query(
    "SELECT * FROM bonus_codes ORDER BY created_at DESC LIMIT 20"
  );

  if (!codes.rows.length) {
    await bot.sendMessage(chatId,
      `🎁 ${b("Bonus Codes")}\n\n${i("No codes created yet.")}\n\nCreate one:\n${code("/createcode CODE 0.25 100")}`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
      }
    );
    return;
  }

  let text = `🎁 ${b("Bonus Codes")}\n\n`;
  for (const c of codes.rows) {
    const expired = c.expires_at && new Date(c.expires_at) < new Date() ? " ❌EXP" : "";
    const pct = Math.round((c.uses_count / c.max_uses) * 100);
    text += `${code(c.code)} — $${Number(c.amount).toFixed(2)} — ${c.uses_count}/${c.max_uses} (${pct}%)${expired}\n`;
  }
  text += `\n${i("Create: /createcode CODE AMOUNT [MAXUSES]")}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
  });
}

// ─── TASKS ───────────────────────────────────────────────────────────────────

export async function handleAdminViewTasks(bot: TelegramBot, chatId: number): Promise<void> {
  const tasks = await query(
    `SELECT t.*, COUNT(ut.id) as total_starts, COUNT(CASE WHEN ut.completed THEN 1 END) as completions,
            COUNT(CASE WHEN ut.reward_claimed THEN 1 END) as claims
     FROM tasks t LEFT JOIN user_tasks ut ON ut.task_id = t.id
     GROUP BY t.id ORDER BY t.id`
  );

  let text = `📋 ${b("Tasks Overview")}\n\n`;
  for (const t of tasks.rows) {
    const status = t.is_active ? "✅" : "❌";
    text += `${status} ${b(t.name)}\n`;
    text += `   Reward: ${formatUSD(parseFloat(t.reward))} | Type: ${t.task_type}\n`;
    text += `   Started: ${t.total_starts} · Done: ${t.completions} · Claimed: ${t.claims}\n\n`;
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "« Back", callback_data: "admin_panel" }]] },
  });
}

// ─── BAN/VIP ─────────────────────────────────────────────────────────────────

export async function handleAdminBanUser(bot: TelegramBot, chatId: number, targetId: number): Promise<void> {
  const user = await getUser(targetId);
  if (!user) { await bot.sendMessage(chatId, "❌ User not found."); return; }

  const newStatus = !user.is_banned;
  await query("UPDATE bot_users SET is_banned=$1 WHERE id=$2", [newStatus, targetId]);
  await bot.sendMessage(chatId, `${newStatus ? "🚫 Banned" : "✅ Unbanned"} user #${targetId}`);
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────

export async function handleAdminSetSetting(bot: TelegramBot, chatId: number, key: string, value: string): Promise<void> {
  await setSetting(key, value);
  await bot.sendMessage(chatId, `✅ ${b(key)} = ${code(value)}`, { parse_mode: "HTML" });
}

// ─── USER GAMES ──────────────────────────────────────────────────────────────

export async function handleAdminUserGames(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const games = await query(
    `SELECT game_type, mode, bet_amount, winner_id, completed_at
     FROM game_bets WHERE (creator_id=$1 OR opponent_id=$1) AND status='completed'
     ORDER BY completed_at DESC LIMIT 10`,
    [userId]
  );

  if (!games.rows.length) {
    await bot.sendMessage(chatId, `No games found for user #${userId}.`);
    return;
  }

  let text = `🎮 ${b("Games for #" + userId)}\n\n`;
  for (const g of games.rows) {
    const won = g.winner_id === userId ? "✅ Won" : g.winner_id === null ? "🤝 Draw" : "❌ Lost";
    text += `${won} ${g.game_type} (${g.mode}) — ${formatUSD(parseFloat(g.bet_amount))}\n`;
  }

  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}
