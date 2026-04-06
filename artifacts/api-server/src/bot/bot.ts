import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";
import { handleStart } from "./handlers/start";
import { handleBalance, handleTransactionHistory } from "./handlers/balance";
import { handleDeposit, handleDepositUSDT, handleDepositTON, handleDepositStars, processUSDTDepositAmount, sendStarsInvoice, handleSuccessfulStarsPayment, handlePendingStars } from "./handlers/deposit";
import { handleWithdraw, handleWithdrawUSDT, processWithdrawAmount, processWithdrawAddress } from "./handlers/withdraw";
import { handlePlay, handleModeSelect, handleGameSelect, handleBetSelect, processBet, handleRPSChoice, handleQuickJoin, userState } from "./handlers/play";
import { handleReferral } from "./handlers/referral";
import { handleLeaderboard } from "./handlers/leaderboard";
import { handleTasks, handleClaimTask } from "./handlers/tasks";
import {
  isAdmin, handleAdminPanel, handleAdminProfit, handleAdminPendingWithdrawals,
  handleAdminApproveWithdrawal, handleAdminRejectWithdrawal, handleAdminUserLookup,
  handleAdminUserDetail, handleAdminRiskSettings, handleAdminBanUser,
  handleAdminSetSetting, handleAdminRecentGames, handleAdminTopWinners
} from "./handlers/admin";
import { acceptBet, cancelBet } from "./services/gameService";
import { expireOldBets } from "./services/gameService";
import { processLockedStars } from "./services/depositService";
import { adjustBalance, getUser } from "./services/userService";
import { formatUSD, b, code } from "./utils";
import { query } from "./db";
import { resolveGameByValues, formatDiceResult, telegramDiceEmoji } from "./games/engine";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

// Per-user multi-step state
const pendingWithdrawAmount = new Map<number, number>();
const pendingAdminLookup = new Set<number>();

export function initBot(): TelegramBot {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  // Global error guard — never let unhandled rejections kill the process
  bot.on("polling_error", (err) => {
    logger.error({ err: err.message }, "Telegram polling error");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled rejection");
  });

  logger.info("Telegram bot starting...");

  // ─── COMMANDS ────────────────────────────────────────────────────────────────

  bot.onText(/\/start(.*)/, async (msg) => {
    try { await handleStart(bot, msg); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/balance/, async (msg) => {
    try { await handleBalance(bot, msg); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/deposit/, async (msg) => {
    if (msg.chat.type !== "private") { await bot.sendMessage(msg.chat.id, "💰 Please use /deposit in private chat."); return; }
    try { await handleDeposit(bot, msg.chat.id, msg.from!.id); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/withdraw/, async (msg) => {
    if (msg.chat.type !== "private") { await bot.sendMessage(msg.chat.id, "💸 Please use /withdraw in private chat."); return; }
    try { await handleWithdraw(bot, msg.chat.id, msg.from!.id); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/play/, async (msg) => {
    try {
      const user = await getUser(msg.from!.id);
      if (!user) { await bot.sendMessage(msg.chat.id, "Please /start the bot first."); return; }
      if (user.is_banned) { await bot.sendMessage(msg.chat.id, "🚫 Your account has been suspended."); return; }
      await handlePlay(bot, msg.chat.id, msg.from!.id);
    } catch (e) { logger.error(e); }
  });

  bot.onText(/\/referral/, async (msg) => {
    try { await handleReferral(bot, msg.chat.id, msg.from!.id); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/tasks/, async (msg) => {
    try { await handleTasks(bot, msg.chat.id, msg.from!.id); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/leaderboard/, async (msg) => {
    try { await handleLeaderboard(bot, msg.chat.id, msg.from!.id); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/stats/, async (msg) => {
    try { await handleBalance(bot, msg); } catch (e) { logger.error(e); }
  });

  // Admin commands
  bot.onText(/\/admin/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try { await handleAdminPanel(bot, msg.chat.id); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/set (.+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    try { await handleAdminSetSetting(bot, msg.chat.id, match![1], match![2]); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/addbalance (\d+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const targetId = parseInt(match![1]);
    const amount = parseFloat(match![2]);
    if (!isNaN(amount) && amount > 0) {
      try {
        await adjustBalance(targetId, amount, 0, "admin_add", `Admin added ${formatUSD(amount)}`);
        await bot.sendMessage(msg.chat.id, `✅ Added ${formatUSD(amount)} to user #${targetId}`);
        await bot.sendMessage(targetId, `💰 ${b("Admin added " + formatUSD(amount) + " to your balance!")}`, { parse_mode: "HTML" });
      } catch { /* user blocked bot */ }
    }
  });

  bot.onText(/\/removebalance (\d+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const targetId = parseInt(match![1]);
    const amount = parseFloat(match![2]);
    if (!isNaN(amount) && amount > 0) {
      try {
        await adjustBalance(targetId, -amount, 0, "admin_remove", `Admin removed ${formatUSD(amount)}`);
        await bot.sendMessage(msg.chat.id, `✅ Removed ${formatUSD(amount)} from user #${targetId}`);
      } catch (e) { await bot.sendMessage(msg.chat.id, `❌ Error: ${(e as Error).message}`); }
    }
  });

  bot.onText(/\/ban (\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    try { await handleAdminBanUser(bot, msg.chat.id, parseInt(match![1])); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/join(.*)/, async (msg, match) => {
    const gameType = match![1].trim() || undefined;
    try { await handleQuickJoin(bot, msg.chat.id, msg.from!.id, gameType); } catch (e) { logger.error(e); }
  });

  // Quick bet: /bet dice 0.5
  bot.onText(/\/bet (.+) (.+)/, async (msg, match) => {
    const gameType = match![1].toLowerCase();
    const amount = parseFloat(match![2]);
    const validGames = ["dice", "slots", "rps", "basketball", "bowling", "darts", "football"];
    if (!validGames.includes(gameType)) { await bot.sendMessage(msg.chat.id, `❌ Invalid game. Valid: ${validGames.join(", ")}`); return; }
    if (isNaN(amount) || amount < 0.02) { await bot.sendMessage(msg.chat.id, "❌ Invalid amount. Min: $0.02"); return; }
    const mode = msg.chat.type === "private" ? "bot" : "pvp";
    try { await processBet(bot, msg.chat.id, msg.from!.id, mode, gameType, amount); } catch (e) { logger.error(e); }
  });

  // ─── TELEGRAM STARS PAYMENT FLOW ─────────────────────────────────────────────

  // Must answer pre_checkout_query or payment will fail
  bot.on("pre_checkout_query", async (query) => {
    try {
      await bot.answerPreCheckoutQuery(query.id, true);
    } catch (e) {
      logger.error({ e }, "Failed to answer pre_checkout_query");
    }
  });

  // Successful Stars payment
  bot.on("message", async (msg) => {
    if (msg.successful_payment) {
      try {
        const sp = msg.successful_payment;
        await handleSuccessfulStarsPayment(
          bot,
          msg.chat.id,
          msg.from!.id,
          sp.invoice_payload,
          sp.telegram_payment_charge_id
        );
      } catch (e) { logger.error(e); }
      return;
    }

    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    const text = msg.text.trim();

    // ── Main menu buttons ──────────────────────────────────────────────────────
    if (text === "🎮 Play") {
      try {
        const user = await getUser(userId);
        if (user?.is_banned) { await bot.sendMessage(chatId, "🚫 Account suspended."); return; }
        await handlePlay(bot, chatId, userId);
      } catch (e) { logger.error(e); }
      return;
    }

    if (text === "💰 Wallet") {
      if (msg.chat.type !== "private") { await bot.sendMessage(chatId, "💰 Please use /balance in private chat."); return; }
      try { await handleBalance(bot, msg); } catch (e) { logger.error(e); }
      return;
    }

    if (text === "🏆 Leaderboard") {
      try { await handleLeaderboard(bot, chatId, userId); } catch (e) { logger.error(e); }
      return;
    }

    if (text === "👥 Refer & Earn") {
      try { await handleReferral(bot, chatId, userId); } catch (e) { logger.error(e); }
      return;
    }

    if (text === "📋 Tasks") {
      try { await handleTasks(bot, chatId, userId); } catch (e) { logger.error(e); }
      return;
    }

    if (text === "📊 My Stats") {
      try { await handleBalance(bot, msg); } catch (e) { logger.error(e); }
      return;
    }

    // ── Multi-step flows ───────────────────────────────────────────────────────
    const state = userState.get(userId);

    if (state?.step === "enter_custom_bet") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount < 0.02) { await bot.sendMessage(chatId, "❌ Invalid amount. Min $0.02"); return; }
      userState.delete(userId);
      try { await processBet(bot, chatId, userId, state.mode!, state.gameType!, amount); } catch (e) { logger.error(e); }
      return;
    }

    // Withdraw flow: reply to "amount you want to withdraw"
    if (msg.reply_to_message?.text?.includes("amount you want to withdraw")) {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount < 0.5) { await bot.sendMessage(chatId, "❌ Invalid amount. Min $0.50"); return; }
      pendingWithdrawAmount.set(userId, amount);
      try { await processWithdrawAmount(bot, chatId, userId, text); } catch (e) { logger.error(e); }
      return;
    }

    // Withdraw flow: reply to "wallet address"
    if (msg.reply_to_message?.text?.includes("wallet address")) {
      const amount = pendingWithdrawAmount.get(userId);
      if (!amount) { await bot.sendMessage(chatId, "❌ Session expired. Please start withdrawal again."); return; }
      pendingWithdrawAmount.delete(userId);
      try { await processWithdrawAddress(bot, chatId, userId, text, amount); } catch (e) { logger.error(e); }
      return;
    }

    // USDT deposit flow: reply to "amount in USD"
    if (msg.reply_to_message?.text?.includes("amount in USD") ||
        msg.reply_to_message?.text?.includes("deposit in USD")) {
      try { await processUSDTDepositAmount(bot, chatId, userId, text); } catch (e) { logger.error(e); }
      return;
    }

    // Admin lookup reply
    if (isAdmin(userId) && pendingAdminLookup.has(userId)) {
      pendingAdminLookup.delete(userId);
      try { await handleAdminUserDetail(bot, chatId, text); } catch (e) { logger.error(e); }
      return;
    }
  });

  // ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────

  bot.on("callback_query", async (callbackQuery) => {
    const msg = callbackQuery.message!;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data || "";

    try { await bot.answerCallbackQuery(callbackQuery.id); } catch { /* ignore */ }

    try {
      await handleCallback(bot, chatId, userId, data, callbackQuery.id);
    } catch (e) {
      logger.error({ e, data }, "Callback error");
      try { await bot.sendMessage(chatId, "❌ An error occurred. Please try again."); } catch { /* ignore */ }
    }
  });

  // ─── BACKGROUND TASKS ────────────────────────────────────────────────────────

  setInterval(async () => {
    try { await expireOldBets(); } catch { /* ignore */ }
  }, 60 * 1000);

  setInterval(async () => {
    try { await processLockedStars(); } catch { /* ignore */ }
  }, 60 * 60 * 1000);

  setInterval(async () => {
    try {
      const expired = await query(
        `SELECT id, bonus_balance FROM bot_users 
         WHERE newbie_bonus_given=TRUE AND newbie_bonus_expires_at IS NOT NULL 
         AND newbie_bonus_expires_at < NOW() AND bonus_balance > 0`
      );
      for (const user of expired.rows) {
        const bonus = parseFloat(user.bonus_balance);
        await query("UPDATE bot_users SET bonus_balance=0, newbie_bonus_expires_at=NULL, updated_at=NOW() WHERE id=$1", [user.id]);
        await query(
          `INSERT INTO house_stats (date, recovered_bonus) VALUES (CURRENT_DATE, $1)
           ON CONFLICT (date) DO UPDATE SET recovered_bonus = house_stats.recovered_bonus + $1`,
          [bonus]
        );
      }
    } catch { /* ignore */ }
  }, 24 * 60 * 60 * 1000);

  logger.info("Telegram bot initialized successfully!");
  return bot;

  // ─── CALLBACK HANDLER ─────────────────────────────────────────────────────────

  async function handleCallback(bot: TelegramBot, chatId: number, userId: number, data: string, callbackQueryId: string): Promise<void> {
    // Navigation
    if (data === "back_main") { await handlePlay(bot, chatId, userId); return; }
    if (data === "back_wallet") { await handleDeposit(bot, chatId, userId); return; }

    // Mode select
    if (data === "mode_pvp") { await handleModeSelect(bot, chatId, userId, "pvp"); return; }
    if (data === "mode_bot") { await handleModeSelect(bot, chatId, userId, "bot"); return; }

    // Game select: game_pvp_dice, game_bot_slots
    const gameMatch = data.match(/^game_(pvp|bot)_(.+)$/);
    if (gameMatch) {
      const [, mode, gameType] = gameMatch;
      if (gameType === "back") { await handlePlay(bot, chatId, userId); return; }
      await handleGameSelect(bot, chatId, userId, mode, gameType);
      return;
    }

    // Bet select: bet_pvp_dice_0.05
    const betMatch = data.match(/^bet_(pvp|bot)_(.+)_(.+)$/);
    if (betMatch) {
      const [, mode, gameType, amount] = betMatch;
      await handleBetSelect(bot, chatId, userId, mode, gameType, amount);
      return;
    }

    // Stars invoice buttons: stars_invoice_20
    const starsInvoiceMatch = data.match(/^stars_invoice_(\d+)$/);
    if (starsInvoiceMatch) {
      await sendStarsInvoice(bot, chatId, userId, parseInt(starsInvoiceMatch[1]));
      return;
    }

    // Accept bet
    if (data.startsWith("accept_bet_")) {
      const betId = parseInt(data.replace("accept_bet_", ""));
      await handleAcceptBet(bot, chatId, userId, betId);
      return;
    }

    // Cancel bet
    if (data.startsWith("cancel_bet_")) {
      const betId = parseInt(data.replace("cancel_bet_", ""));
      const betRes = await query("SELECT * FROM game_bets WHERE id=$1 AND status='waiting'", [betId]);
      const bet = betRes.rows[0];
      if (!bet || bet.creator_id !== userId) { await bot.sendMessage(chatId, "❌ You can't cancel this bet."); return; }
      await cancelBet(betId);
      await bot.sendMessage(chatId, `✅ Bet #${betId} cancelled. Funds refunded.`);
      return;
    }

    // RPS choice
    const rpsMatch = data.match(/^rps_(creator|opponent)_(\d+)_(rock|paper|scissors)$/);
    if (rpsMatch) {
      const [, role, betIdStr, choice] = rpsMatch;
      await handleRPSChoice(bot, chatId, userId, parseInt(betIdStr), choice, role === "creator");
      return;
    }

    // Wallet
    if (data === "wallet_deposit") { await handleDeposit(bot, chatId, userId); return; }
    if (data === "wallet_withdraw") { await handleWithdraw(bot, chatId, userId); return; }
    if (data === "wallet_transactions") { await handleTransactionHistory(bot, chatId, userId); return; }
    if (data === "wallet_pending_stars") { await handlePendingStars(bot, chatId, userId); return; }
    if (data === "deposit_usdt") { await handleDepositUSDT(bot, chatId, userId); return; }
    if (data === "deposit_stars") { await handleDepositStars(bot, chatId, userId); return; }
    if (data === "deposit_ton") { await handleDepositTON(bot, chatId, userId); return; }
    if (data === "withdraw_usdt") { await handleWithdrawUSDT(bot, chatId, userId); return; }

    if (data === "withdraw_history") {
      const { getWithdrawHistory } = await import("./services/withdrawService");
      const history = await getWithdrawHistory(userId, 10);
      if (!history.length) { await bot.sendMessage(chatId, "No withdrawal history."); return; }
      let text = `📋 ${b("Withdrawal History")}\n\n`;
      for (const w of history) {
        const icon = w.status === "approved" ? "✅" : w.status === "rejected" ? "❌" : "⏳";
        text += `${icon} ${formatUSD(parseFloat(String(w.net_amount)))} — ${w.status}\n`;
      }
      await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
      return;
    }

    // Tasks
    if (data.startsWith("claim_task_")) {
      const taskId = parseInt(data.replace("claim_task_", ""));
      await handleClaimTask(bot, callbackQueryId, chatId, userId, taskId);
      return;
    }

    // Admin callbacks
    if (isAdmin(userId)) {
      if (data === "admin_profit") { await handleAdminProfit(bot, chatId); return; }
      if (data === "admin_pending_withdrawals") { await handleAdminPendingWithdrawals(bot, chatId); return; }
      if (data === "admin_risk_settings") { await handleAdminRiskSettings(bot, chatId); return; }
      if (data === "admin_recent_games") { await handleAdminRecentGames(bot, chatId); return; }
      if (data === "admin_top_winners") { await handleAdminTopWinners(bot, chatId); return; }

      if (data === "admin_user_lookup") {
        pendingAdminLookup.add(userId);
        await handleAdminUserLookup(bot, chatId);
        return;
      }

      const approveMatch = data.match(/^admin_approve_(\d+)$/);
      if (approveMatch) { await handleAdminApproveWithdrawal(bot, chatId, parseInt(approveMatch[1])); return; }

      const rejectMatch = data.match(/^admin_reject_(\d+)$/);
      if (rejectMatch) { await handleAdminRejectWithdrawal(bot, chatId, parseInt(rejectMatch[1])); return; }

      const banMatch = data.match(/^admin_ban_(\d+)$/);
      if (banMatch) { await handleAdminBanUser(bot, chatId, parseInt(banMatch[1])); return; }

      const vipMatch = data.match(/^admin_vip_(\d+)$/);
      if (vipMatch) {
        const targetId = parseInt(vipMatch[1]);
        const u = await getUser(targetId);
        if (u) {
          await query("UPDATE bot_users SET is_vip=$1 WHERE id=$2", [!u.is_vip, targetId]);
          await bot.sendMessage(chatId, `💎 VIP ${!u.is_vip ? "granted" : "removed"} for user #${targetId}`);
        }
        return;
      }
    }
  }

  // ─── PvP Accept Bet Helper ────────────────────────────────────────────────────

  async function handleAcceptBet(bot: TelegramBot, chatId: number, userId: number, betId: number): Promise<void> {
    const bet = await acceptBet(betId, userId);
    if (!bet) { await bot.sendMessage(chatId, "❌ Bet not available or already accepted."); return; }

    const betRes = await query("SELECT * FROM game_bets WHERE id=$1", [betId]);
    const gameBet = betRes.rows[0];

    await bot.sendMessage(chatId, `✅ Bet #${betId} accepted! Game starting...`);

    const diceEmoji = telegramDiceEmoji(gameBet.game_type);
    const targetChat = gameBet.group_chat_id || chatId;

    if (gameBet.game_type === "rps") {
      const { rpsKeyboard } = await import("./handlers/keyboard");
      try {
        await bot.sendMessage(gameBet.creator_id, `⚔️ PvP RPS! Make your choice:`, { reply_markup: rpsKeyboard(betId, true) });
      } catch { /* ignore */ }
      await bot.sendMessage(chatId, `⚔️ PvP RPS! Make your choice:`, { reply_markup: rpsKeyboard(betId, false) });
      return;
    }

    try {
      const creatorDice = await bot.sendDice(targetChat, { emoji: diceEmoji });
      await new Promise(r => setTimeout(r, 3500));
      const opponentDice = await bot.sendDice(targetChat, { emoji: diceEmoji });
      await new Promise(r => setTimeout(r, 3500));

      const creatorVal = creatorDice.dice!.value;
      const opponentVal = opponentDice.dice!.value;
      const winner = resolveGameByValues(gameBet.game_type, creatorVal, opponentVal);
      const winnerId = winner === "creator" ? gameBet.creator_id : (winner === "draw" ? null : userId);

      const { completeBet } = await import("./services/gameService");
      const completedBet = await completeBet(
        betId,
        formatDiceResult(gameBet.game_type, creatorVal),
        formatDiceResult(gameBet.game_type, opponentVal),
        winnerId
      );

      const payout = parseFloat(String(completedBet.payout));
      let resultMsg = winner === "draw"
        ? `🤝 ${b("DRAW!")} Both players refunded.`
        : `🏆 ${b("Player #" + winnerId + " WINS ")} ${formatUSD(payout)}!`;

      await bot.sendMessage(targetChat, resultMsg, { parse_mode: "HTML" });

      // Notify both players in private if game was in a group
      if (gameBet.group_chat_id) {
        const loserMsg = winner === "draw"
          ? `🤝 Draw! Your bet was refunded.`
          : winnerId !== gameBet.creator_id
            ? `💀 You lost the ${gameBet.game_type} bet. Better luck next time!`
            : `🏆 You won ${formatUSD(payout)}!`;
        try { await bot.sendMessage(gameBet.creator_id, loserMsg); } catch { /* ignore */ }
        if (winner !== "draw") {
          const opponentMsg = winnerId === userId ? `🏆 You won ${formatUSD(payout)}!` : `💀 You lost! Better luck next time.`;
          try { await bot.sendMessage(userId, opponentMsg); } catch { /* ignore */ }
        }
      }
    } catch (e) {
      logger.error(e, "Error completing PvP bet");
      await bot.sendMessage(chatId, "❌ Error completing game. Bets refunded.");
      await cancelBet(betId);
    }
  }
}
