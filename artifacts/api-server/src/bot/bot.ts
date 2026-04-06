import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";
import { handleStart, handleHelp } from "./handlers/start";
import { handleBalance, handleTransactionHistory } from "./handlers/balance";
import {
  handleDeposit, handleDepositUSDT, handleDepositTON, handleDepositStars,
  handleStarsCustomAmount, processUSDTDepositAmount, sendStarsInvoice,
  handleSuccessfulStarsPayment, handlePendingStars, MIN_STARS
} from "./handlers/deposit";
import { refundStarsByChargeId } from "./services/depositService";
import { initLogService, sendGameLog } from "./services/logService";
import { handleWithdraw, handleWithdrawUSDT, processWithdrawAmount, processWithdrawAddress } from "./handlers/withdraw";
import { handlePlay, handleModeSelect, handleGameSelect, handleBetSelect, processBet, handleRPSChoice, handleQuickJoin, handleAcceptFromDeepLink, userState } from "./handlers/play";
import { handleReferral } from "./handlers/referral";
import { handleLeaderboard } from "./handlers/leaderboard";
import { handleTasks, handleClaimTask } from "./handlers/tasks";
import {
  isAdmin, handleAdminPanel, handleAdminProfit, handleAdminPendingWithdrawals,
  handleAdminApproveWithdrawal, handleAdminRejectWithdrawal, handleAdminUserLookup,
  handleAdminUserDetail, handleAdminRiskSettings, handleAdminBanUser,
  handleAdminSetSetting, handleAdminRecentGames, handleAdminTopWinners
} from "./handlers/admin";
import { acceptBet, cancelBet, expireOldBets } from "./services/gameService";
import { processLockedStars } from "./services/depositService";
import { adjustBalance, getUser, getUserBalance } from "./services/userService";
import { formatUSD, escapeHtml, b, i, code } from "./utils";
import { query } from "./db";
import { resolveGameByValues, formatDiceResult, telegramDiceEmoji } from "./games/engine";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

// Per-user multi-step state
const pendingWithdrawAmount = new Map<number, number>();
const pendingAdminLookup = new Set<number>();
const pendingStarsCustom = new Set<number>(); // users who clicked "Custom Amount" for Stars

export function initBot(): TelegramBot {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  // Global error guards — never let unhandled rejections kill the process
  bot.on("polling_error", (err) => {
    logger.error({ err: err.message }, "Telegram polling error");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled rejection");
  });

  logger.info("Telegram bot starting...");
  initLogService(bot);

  // ─── REGISTER COMMANDS WITH TELEGRAM ──────────────────────────────────────
  // Public commands — visible to ALL users
  const publicCommands: TelegramBot.BotCommand[] = [
    { command: "start",       description: "🏠 Start / Main menu" },
    { command: "help",        description: "📋 All commands & how to play" },
    { command: "play",        description: "🎮 Start a game" },
    { command: "balance",     description: "💰 Your wallet & balance" },
    { command: "deposit",     description: "📥 Deposit USDT / Stars / TON" },
    { command: "withdraw",    description: "💸 Withdraw your winnings" },
    { command: "leaderboard", description: "🏆 Top players leaderboard" },
    { command: "referral",    description: "👥 Refer friends & earn 5%" },
    { command: "tasks",       description: "📋 Daily tasks & bonus rewards" },
    { command: "stats",       description: "📊 Your game statistics" },
    { command: "join",        description: "⚡ Browse open PvP bets" },
    { command: "support",     description: "💬 Contact support" },
  ];

  bot.setMyCommands(publicCommands).then(() => {
    logger.info("Bot commands registered with Telegram");
  }).catch((err) => {
    logger.error({ err }, "Failed to register commands");
  });

  // Admin commands — ONLY visible in the admin's private chat
  // Include public commands too so admin can see everything in one list
  bot.setMyCommands([
    ...publicCommands,
    { command: "admin",         description: "👑 Admin panel" },
    { command: "set",           description: "⚙️ /set key value" },
    { command: "addbalance",    description: "➕ /addbalance userId amount" },
    { command: "removebalance", description: "➖ /removebalance userId amount" },
    { command: "ban",           description: "🚫 /ban userId" },
    { command: "refund",        description: "↩️ /refund <chargeId> — Refund Stars" },
  ], {
    scope: { type: "chat", chat_id: parseInt(process.env.ADMIN_TELEGRAM_ID || "2139807311") },
  }).catch(() => { /* admin may not have started the bot yet */ });

  // ─── COMMANDS ────────────────────────────────────────────────────────────────

  bot.onText(/\/start(.*)/, async (msg) => {
    try {
      const payload = (msg.text || "").split(" ")[1] || "";
      // Deep link: /start accept_42 — let someone accept a PvP bet from private chat
      const acceptMatch = payload.match(/^accept_(\d+)$/);
      if (acceptMatch && msg.from) {
        await handleAcceptFromDeepLink(bot, msg.chat.id, msg.from.id, parseInt(acceptMatch[1]));
        return;
      }
      await handleStart(bot, msg);
    } catch (e) { logger.error(e); }
  });

  bot.onText(/\/help/, async (msg) => {
    try { await handleHelp(bot, msg.chat.id); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/support/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
      `💬 ${b("RAIZO GAMES Support")}\n\n`
      + `Need help? Our support team is available 24/7.\n\n`
      + `📩 Chat: https://t.me/RaizoGamesSupport\n`
      + `📋 /help — Command guide & game rules`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 Open Support Chat", url: "https://t.me/RaizoGamesSupport" }],
          ],
        },
      }
    );
  });

  bot.onText(/\/balance/, async (msg) => {
    try { await handleBalance(bot, msg); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/deposit/, async (msg) => {
    if (msg.chat.type !== "private") {
      await bot.sendMessage(msg.chat.id, "💰 Please use /deposit in private chat.");
      return;
    }
    try { await handleDeposit(bot, msg.chat.id, msg.from!.id); } catch (e) { logger.error(e); }
  });

  bot.onText(/\/withdraw/, async (msg) => {
    if (msg.chat.type !== "private") {
      await bot.sendMessage(msg.chat.id, "💸 Please use /withdraw in private chat.");
      return;
    }
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

  bot.onText(/\/join(.*)/, async (msg, match) => {
    const gameType = match![1].trim() || undefined;
    try { await handleQuickJoin(bot, msg.chat.id, msg.from!.id, gameType); } catch (e) { logger.error(e); }
  });

  // Quick bet: /bet dice 0.5
  bot.onText(/\/bet (.+) (.+)/, async (msg, match) => {
    const gameType = match![1].toLowerCase();
    const amount = parseFloat(match![2]);
    const validGames = ["dice", "slots", "rps", "basketball", "bowling", "darts", "football"];
    if (!validGames.includes(gameType)) {
      await bot.sendMessage(msg.chat.id, `❌ Invalid game. Valid: ${validGames.join(", ")}`);
      return;
    }
    if (isNaN(amount) || amount < 0.02) {
      await bot.sendMessage(msg.chat.id, "❌ Invalid amount. Min: $0.02");
      return;
    }
    const mode = msg.chat.type === "private" ? "bot" : "pvp";
    try { await processBet(bot, msg.chat.id, msg.from!.id, mode, gameType, amount); } catch (e) { logger.error(e); }
  });

  // ─── Admin commands ─────────────────────────────────────────────────────────

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
        try {
          await bot.sendMessage(targetId, `💰 ${b("Admin added " + formatUSD(amount) + " to your balance!")}`, { parse_mode: "HTML" });
        } catch { /* user may have blocked bot */ }
      } catch (e) { await bot.sendMessage(msg.chat.id, `❌ Error: ${(e as Error).message}`); }
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

  // Refund Stars by Telegram charge ID — admin only
  // This calls Telegram's actual refundStarPayment API to return Stars to the user
  bot.onText(/\/refund (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const chargeId = match![1].trim();
    const adminChatId = msg.chat.id;

    try {
      const result = await refundStarsByChargeId(chargeId);

      if (result.alreadyRefunded) {
        await bot.sendMessage(adminChatId,
          `⚠️ ${b("Already Refunded")}\n\nCharge ID ${code(chargeId)} was already refunded previously.`,
          { parse_mode: "HTML" }
        );
        return;
      }

      if (!result.success || !result.userId) {
        await bot.sendMessage(adminChatId,
          `❌ ${b("Charge ID Not Found")}\n\n${code(chargeId)}\n\nMake sure you're using the exact Telegram payment charge ID (starts with something like ${code("5678...")}).`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // ── Actually send Stars back via Telegram API ────────────────────────
      let telegramRefundOk = false;
      let telegramError = "";
      try {
        const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/refundStarPayment`;
        const axios = (await import("axios")).default;
        const tgRes = await axios.post(apiUrl, {
          user_id: result.userId,
          telegram_payment_charge_id: chargeId,
        }, { timeout: 15000 });

        telegramRefundOk = tgRes.data?.ok === true;
        if (!telegramRefundOk) {
          telegramError = tgRes.data?.description || "Unknown Telegram error";
        }
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { description?: string } }; message?: string };
        telegramError = axiosErr?.response?.data?.description || axiosErr?.message || "Network error";
      }

      if (telegramRefundOk) {
        // Success — Stars are back in the user's account
        await bot.sendMessage(adminChatId,
          `✅ ${b("Stars Refunded Successfully!")}\n\n`
          + `👤 User: #${result.userId}\n`
          + `⭐ Stars: ${result.starsCount}\n`
          + `🔖 Charge ID: ${code(chargeId)}\n\n`
          + `${i("Stars returned to user's Telegram account. Bot balance adjusted.")}`,
          { parse_mode: "HTML" }
        );
        // Notify user that Stars arrived back
        try {
          await bot.sendMessage(result.userId,
            `⭐ ${b("Stars Refund Received!")}\n\n`
            + `${result.starsCount} ⭐ Stars have been returned to your Telegram account.\n\n`
            + `${i("Your RAIZO GAMES balance has been adjusted accordingly.")}`,
            { parse_mode: "HTML" }
          );
        } catch { /* user may have blocked bot */ }
      } else {
        // Telegram rejected the refund (charge too old, already refunded on TG side, etc.)
        await bot.sendMessage(adminChatId,
          `⚠️ ${b("DB Updated — But Telegram Rejected Refund")}\n\n`
          + `Charge ID: ${code(chargeId)}\n`
          + `User: #${result.userId} | Stars: ${result.starsCount}\n\n`
          + `❌ Telegram API error: ${escapeHtml(telegramError)}\n\n`
          + `${i("The deposit was marked as refunded in our database.\nTelegram may have already refunded this, or the charge ID is invalid/expired (21-day window).")}`,
          { parse_mode: "HTML" }
        );
      }
    } catch (e) {
      await bot.sendMessage(adminChatId, `❌ Error: ${escapeHtml((e as Error).message)}`);
    }
  });

  // ─── TELEGRAM STARS PAYMENT FLOW ─────────────────────────────────────────────

  // Must answer pre_checkout_query or the payment is cancelled by Telegram
  bot.on("pre_checkout_query", async (pcq) => {
    try {
      await bot.answerPreCheckoutQuery(pcq.id, true);
    } catch (e) {
      logger.error({ e }, "Failed to answer pre_checkout_query");
    }
  });

  // ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────

  bot.on("message", async (msg) => {
    // Successful Stars payment
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

    // ── Main menu keyboard buttons ──────────────────────────────────────────────
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

    // ── Multi-step flows ────────────────────────────────────────────────────────
    const state = userState.get(userId);

    // Custom game bet entry
    if (state?.step === "enter_custom_bet") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount < 0.02) {
        await bot.sendMessage(chatId, "❌ Invalid amount. Min $0.02");
        return;
      }
      userState.delete(userId);
      try { await processBet(bot, chatId, userId, state.mode!, state.gameType!, amount); } catch (e) { logger.error(e); }
      return;
    }

    // ── Stars custom amount (set from callback stars_custom_amount) ──────────────
    if (pendingStarsCustom.has(userId)) {
      pendingStarsCustom.delete(userId);
      const stars = parseInt(text);
      if (isNaN(stars) || stars < MIN_STARS) {
        await bot.sendMessage(chatId, `❌ Minimum is ${MIN_STARS} Stars. Please enter a valid number.`);
        return;
      }
      try { await sendStarsInvoice(bot, chatId, userId, stars); } catch (e) { logger.error(e); }
      return;
    }

    // Stars custom amount via force_reply
    if (msg.reply_to_message?.text?.includes("Custom Stars Amount") ||
        msg.reply_to_message?.text?.includes("number of Stars")) {
      const stars = parseInt(text);
      if (isNaN(stars) || stars < MIN_STARS) {
        await bot.sendMessage(chatId, `❌ Minimum is ${MIN_STARS} Stars.`);
        return;
      }
      try { await sendStarsInvoice(bot, chatId, userId, stars); } catch (e) { logger.error(e); }
      return;
    }

    // USDT deposit amount via force_reply
    if (msg.reply_to_message?.text?.includes("amount in USD") ||
        msg.reply_to_message?.text?.includes("deposit in USD")) {
      try { await processUSDTDepositAmount(bot, chatId, userId, text); } catch (e) { logger.error(e); }
      return;
    }

    // Withdraw amount via force_reply
    if (msg.reply_to_message?.text?.includes("amount you want to withdraw")) {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount < 0.5) {
        await bot.sendMessage(chatId, "❌ Invalid amount. Min $0.50");
        return;
      }
      pendingWithdrawAmount.set(userId, amount);
      try { await processWithdrawAmount(bot, chatId, userId, text); } catch (e) { logger.error(e); }
      return;
    }

    // Withdraw address via force_reply
    if (msg.reply_to_message?.text?.includes("wallet address")) {
      const amount = pendingWithdrawAmount.get(userId);
      if (!amount) {
        await bot.sendMessage(chatId, "❌ Session expired. Please start withdrawal again.");
        return;
      }
      pendingWithdrawAmount.delete(userId);
      try { await processWithdrawAddress(bot, chatId, userId, text, amount); } catch (e) { logger.error(e); }
      return;
    }

    // Admin user lookup reply
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

  // Expire old PvP bets every minute
  setInterval(async () => {
    try { await expireOldBets(); } catch { /* ignore */ }
  }, 60 * 1000);

  // Unlock Stars deposits every hour
  setInterval(async () => {
    try { await processLockedStars(); } catch { /* ignore */ }
  }, 60 * 60 * 1000);

  // Expire newbie bonuses daily
  setInterval(async () => {
    try {
      const expired = await query(
        `SELECT id, bonus_balance FROM bot_users 
         WHERE newbie_bonus_given=TRUE AND newbie_bonus_expires_at IS NOT NULL 
         AND newbie_bonus_expires_at < NOW() AND bonus_balance > 0`
      );
      for (const user of expired.rows) {
        const bonus = parseFloat(user.bonus_balance);
        await query(
          "UPDATE bot_users SET bonus_balance=0, newbie_bonus_expires_at=NULL, updated_at=NOW() WHERE id=$1",
          [user.id]
        );
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

    // Game select: game_pvp_dice | game_bot_slots
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

    // Stars preset invoice: stars_invoice_20
    const starsInvoiceMatch = data.match(/^stars_invoice_(\d+)$/);
    if (starsInvoiceMatch) {
      await sendStarsInvoice(bot, chatId, userId, parseInt(starsInvoiceMatch[1]));
      return;
    }

    // Stars custom amount prompt
    if (data === "stars_custom_amount") {
      pendingStarsCustom.add(userId);
      await handleStarsCustomAmount(bot, chatId);
      return;
    }

    // Accept PvP bet
    if (data.startsWith("accept_bet_")) {
      const betId = parseInt(data.replace("accept_bet_", ""));
      await handleAcceptBet(bot, chatId, userId, betId);
      return;
    }

    // Find open PvP bets (from private chat)
    if (data === "find_pvp_bets") {
      await handleQuickJoin(bot, chatId, userId);
      return;
    }

    // Cancel PvP bet
    if (data.startsWith("cancel_bet_")) {
      const betId = parseInt(data.replace("cancel_bet_", ""));
      const betRes = await query("SELECT * FROM game_bets WHERE id=$1 AND status='waiting'", [betId]);
      const bet = betRes.rows[0];
      if (!bet || bet.creator_id !== userId) { await bot.sendMessage(chatId, "❌ You can't cancel this bet."); return; }
      await cancelBet(betId);
      await bot.sendMessage(chatId, `✅ Bet #${betId} cancelled. Funds refunded.`);
      return;
    }

    // RPS choice: rps_creator_42_rock
    const rpsMatch = data.match(/^rps_(creator|opponent)_(\d+)_(rock|paper|scissors)$/);
    if (rpsMatch) {
      const [, role, betIdStr, choice] = rpsMatch;
      await handleRPSChoice(bot, chatId, userId, parseInt(betIdStr), choice, role === "creator");
      return;
    }

    // Wallet actions
    if (data === "wallet_deposit")      { await handleDeposit(bot, chatId, userId); return; }
    if (data === "wallet_withdraw")     { await handleWithdraw(bot, chatId, userId); return; }
    if (data === "wallet_transactions") { await handleTransactionHistory(bot, chatId, userId); return; }
    if (data === "wallet_pending_stars"){ await handlePendingStars(bot, chatId, userId); return; }
    if (data === "deposit_usdt")        { await handleDepositUSDT(bot, chatId, userId); return; }
    if (data === "deposit_stars")       { await handleDepositStars(bot, chatId, userId); return; }
    if (data === "deposit_ton")         { await handleDepositTON(bot, chatId, userId); return; }
    if (data === "withdraw_usdt")       { await handleWithdrawUSDT(bot, chatId, userId); return; }

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

    // Tasks: claim reward
    if (data.startsWith("claim_task_")) {
      const taskId = parseInt(data.replace("claim_task_", ""));
      await handleClaimTask(bot, callbackQueryId, chatId, userId, taskId);
      return;
    }

    // ── Admin callbacks ──────────────────────────────────────────────────────────
    if (isAdmin(userId)) {
      if (data === "admin_profit")               { await handleAdminProfit(bot, chatId); return; }
      if (data === "admin_pending_withdrawals")  { await handleAdminPendingWithdrawals(bot, chatId); return; }
      if (data === "admin_risk_settings")        { await handleAdminRiskSettings(bot, chatId); return; }
      if (data === "admin_recent_games")         { await handleAdminRecentGames(bot, chatId); return; }
      if (data === "admin_top_winners")          { await handleAdminTopWinners(bot, chatId); return; }

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
    const betRes0 = await query("SELECT * FROM game_bets WHERE id=$1 AND status='waiting'", [betId]);
    const pending = betRes0.rows[0];
    if (!pending) { await bot.sendMessage(chatId, "❌ Bet not found or already accepted."); return; }
    if (pending.creator_id === userId) { await bot.sendMessage(chatId, "❌ You can't accept your own bet!"); return; }
    const opBal = await getUserBalance(userId);
    if ((opBal.real + opBal.bonus) < parseFloat(pending.bet_amount)) {
      await bot.sendMessage(chatId, `❌ ${b("Insufficient balance.")}\nYou need ${formatUSD(parseFloat(pending.bet_amount))} to accept this bet.\n\nDeposit with /deposit`, { parse_mode: "HTML" });
      return;
    }

    const bet = await acceptBet(betId, userId);
    if (!bet) { await bot.sendMessage(chatId, "❌ Bet no longer available."); return; }

    const betRes = await query("SELECT gb.*, u.username, u.first_name FROM game_bets gb JOIN bot_users u ON gb.creator_id=u.id WHERE gb.id=$1", [betId]);
    const gameBet = betRes.rows[0];

    const betAmt = parseFloat(gameBet.bet_amount);
    const creatorName = escapeHtml(gameBet.username ? `@${gameBet.username}` : gameBet.first_name || `Player#${gameBet.creator_id}`);
    const gameLabel = gameBet.game_type.charAt(0).toUpperCase() + gameBet.game_type.slice(1);

    // isPrivatePvP = no group set (both players in private chat)
    const groupChatId: number | null = gameBet.group_chat_id ? parseInt(gameBet.group_chat_id) : null;
    const targetChat = groupChatId || chatId;

    if (gameBet.game_type === "rps") {
      const { rpsKeyboard } = await import("./handlers/keyboard");
      if (groupChatId) {
        await bot.sendMessage(groupChatId, `⚔️ ${b("PvP RPS Started!")}\n${creatorName} vs You!`, { parse_mode: "HTML" });
      }
      // Always prompt both players in their private chats
      try {
        await bot.sendMessage(gameBet.creator_id, `⚔️ ${b("PvP RPS!")}\nOpponent accepted! Make your choice:`, {
          parse_mode: "HTML",
          reply_markup: rpsKeyboard(betId, true),
        });
      } catch { /* creator may not have dm'd the bot */ }
      await bot.sendMessage(chatId, `⚔️ ${b("PvP RPS!")}\nMake your choice:`, {
        parse_mode: "HTML",
        reply_markup: rpsKeyboard(betId, false),
      });
      return;
    }

    const diceEmoji = telegramDiceEmoji(gameBet.game_type);
    const startMsg = `⚔️ ${b("PvP " + gameLabel + " — Game On!")}\n${creatorName} vs You!\nBet: ${formatUSD(betAmt)} each`;

    if (groupChatId) {
      await bot.sendMessage(groupChatId, startMsg, { parse_mode: "HTML" });
    } else {
      // Private PvP — notify creator
      try { await bot.sendMessage(gameBet.creator_id, startMsg + "\n\n🎲 Rolling dice...", { parse_mode: "HTML" }); } catch { /* ignore */ }
      await bot.sendMessage(chatId, startMsg + "\n\n🎲 Rolling dice...", { parse_mode: "HTML" });
    }

    try {
      // Roll dice in target chat (group or acceptor's private)
      const creatorDice = await bot.sendDice(targetChat, { emoji: diceEmoji });
      // If private PvP, also show creator their dice in their chat
      if (!groupChatId) {
        try { await bot.sendDice(gameBet.creator_id, { emoji: diceEmoji }); } catch { /* ignore */ }
      }
      await new Promise(r => setTimeout(r, 3500));

      const opponentDice = await bot.sendDice(targetChat, { emoji: diceEmoji });
      if (!groupChatId) {
        try { await bot.sendDice(gameBet.creator_id, { emoji: diceEmoji }); } catch { /* ignore */ }
      }
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
      const houseFee = parseFloat(String(completedBet.house_fee));
      const netProfit = payout - betAmt;

      // Send game log to channel
      const creatorUserRes = await query("SELECT username, first_name FROM bot_users WHERE id=$1", [gameBet.creator_id]);
      const creatorUser = creatorUserRes.rows[0];
      const creatorDisplayName = creatorUser?.username ? `@${creatorUser.username}` : (creatorUser?.first_name || `User#${gameBet.creator_id}`);
      const opponentUserRes = await query("SELECT username, first_name FROM bot_users WHERE id=$1", [userId]);
      const opponentUser = opponentUserRes.rows[0];
      const opponentDisplayName = opponentUser?.username ? `@${opponentUser.username}` : (opponentUser?.first_name || `User#${userId}`);
      const winnerName = winnerId === gameBet.creator_id ? creatorDisplayName : (winnerId === userId ? opponentDisplayName : undefined);

      sendGameLog({
        gameType: gameBet.game_type,
        mode: "pvp",
        betAmount: betAmt,
        creatorId: gameBet.creator_id,
        creatorName: creatorDisplayName,
        opponentId: userId,
        opponentName: opponentDisplayName,
        creatorResult: formatDiceResult(gameBet.game_type, creatorVal),
        opponentResult: formatDiceResult(gameBet.game_type, opponentVal),
        winnerId,
        winnerName,
        payout,
        houseFee,
      }).catch(() => {});

      // Build per-player result messages
      const creatorWon = winnerId === gameBet.creator_id;
      const opponentWon = winnerId === userId;

      const creatorResultMsg = winner === "draw"
        ? `🤝 ${b("DRAW!")} Your bet was refunded.`
        : creatorWon
          ? `🏆 ${b("YOU WIN!")} +${formatUSD(netProfit)}\n${i("Fee: " + formatUSD(houseFee))}`
          : `💀 ${b("You lost.")} -${formatUSD(betAmt)}`;
      const opponentResultMsg = winner === "draw"
        ? `🤝 ${b("DRAW!")} Your bet was refunded.`
        : opponentWon
          ? `🏆 ${b("YOU WIN!")} +${formatUSD(netProfit)}\n${i("Fee: " + formatUSD(houseFee))}`
          : `💀 ${b("You lost.")} -${formatUSD(betAmt)}`;

      // Show result in the shared chat
      const sharedResultMsg = winner === "draw"
        ? `🤝 ${b("DRAW!")} Both players refunded.`
        : `🏆 ${b("Winner!")} ${creatorWon ? creatorName : "Challenger"} wins ${formatUSD(payout)}!`;

      await bot.sendMessage(targetChat, sharedResultMsg, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🎮 Play Again", callback_data: "back_main" }]] },
      });

      // Always DM both players their personal result + updated balance
      const creatorBal = await getUserBalance(gameBet.creator_id);
      const opponentBal = await getUserBalance(userId);

      try {
        await bot.sendMessage(gameBet.creator_id,
          creatorResultMsg + `\n💵 Balance: ${formatUSD(creatorBal.real)}`,
          { parse_mode: "HTML" }
        );
      } catch { /* ignore */ }

      // Only DM the opponent if the result chat was a group (avoid double msg in private)
      if (groupChatId) {
        try {
          await bot.sendMessage(userId,
            opponentResultMsg + `\n💵 Balance: ${formatUSD(opponentBal.real)}`,
            { parse_mode: "HTML" }
          );
        } catch { /* ignore */ }
      } else {
        // For private PvP, send result to opponent (the acceptor) in their chat
        await bot.sendMessage(chatId,
          opponentResultMsg + `\n💵 Balance: ${formatUSD(opponentBal.real)}`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🎮 Play Again", callback_data: "back_main" }]] },
          }
        );
      }

    } catch (e) {
      logger.error(e, "Error completing PvP bet");
      await bot.sendMessage(chatId, "❌ Error during game. Bets have been refunded.");
      await cancelBet(betId);
    }
  }
}
