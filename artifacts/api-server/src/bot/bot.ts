import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";
import { handleStart } from "./handlers/start";
import { handleBalance, handleTransactionHistory } from "./handlers/balance";
import { handleDeposit, handleDepositUSDT, handleDepositTON, handleDepositStars, processUSDTDepositAmount, processStarsDeposit, handlePendingStars } from "./handlers/deposit";
import { handleWithdraw, handleWithdrawUSDT, processWithdrawAmount, processWithdrawAddress } from "./handlers/withdraw";
import { handlePlay, handleModeSelect, handleGameSelect, handleBetSelect, processBet, handleRPSChoice, handleQuickJoin, userState } from "./handlers/play";
import { handleReferral } from "./handlers/referral";
import { handleLeaderboard } from "./handlers/leaderboard";
import { handleTasks, handleClaimTask } from "./handlers/tasks";
import {
  isAdmin, handleAdminPanel, handleAdminProfit, handleAdminPendingWithdrawals,
  handleAdminApproveWithdrawal, handleAdminRejectWithdrawal, handleAdminUserLookup,
  handleAdminUserDetail, handleAdminRiskSettings, handleAdminBanUser, handleAdminAddBalance,
  handleAdminSetSetting, handleAdminRecentGames
} from "./handlers/admin";
import { acceptBet, cancelBet } from "./services/gameService";
import { expireOldBets } from "./services/gameService";
import { processLockedStars } from "./services/depositService";
import { adjustBalance, getUser } from "./services/userService";
import { formatUSD } from "./utils";
import { query } from "./db";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

export function initBot(): TelegramBot {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  logger.info("Telegram bot starting...");

  // User flow state for multi-step flows
  const pendingWithdrawAmount: Map<number, number> = new Map();
  const pendingAddBalance: Map<number, number> = new Map(); // admin target userId

  // === COMMANDS ===

  bot.onText(/\/start(.*)/, async (msg) => {
    await handleStart(bot, msg);
  });

  bot.onText(/\/balance/, async (msg) => {
    await handleBalance(bot, msg);
  });

  bot.onText(/\/deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    if (msg.chat.type !== "private") {
      await bot.sendMessage(chatId, "💰 Please use /deposit in private chat.");
      return;
    }
    await handleDeposit(bot, chatId, userId);
  });

  bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    if (msg.chat.type !== "private") {
      await bot.sendMessage(chatId, "💸 Please use /withdraw in private chat.");
      return;
    }
    await handleWithdraw(bot, chatId, userId);
  });

  bot.onText(/\/play/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    const user = await getUser(userId);
    if (!user) {
      await bot.sendMessage(chatId, "Please /start the bot first.");
      return;
    }
    if (user.is_banned) {
      await bot.sendMessage(chatId, "🚫 Your account has been suspended.");
      return;
    }
    await handlePlay(bot, chatId, userId);
  });

  bot.onText(/\/referral/, async (msg) => {
    const chatId = msg.chat.id;
    await handleReferral(bot, chatId, msg.from!.id);
  });

  bot.onText(/\/tasks/, async (msg) => {
    const chatId = msg.chat.id;
    await handleTasks(bot, chatId, msg.from!.id);
  });

  bot.onText(/\/leaderboard/, async (msg) => {
    const chatId = msg.chat.id;
    await handleLeaderboard(bot, chatId, msg.from!.id);
  });

  bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    await handleBalance(bot, msg);
  });

  // Admin commands
  bot.onText(/\/admin/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    await handleAdminPanel(bot, msg.chat.id);
  });

  bot.onText(/\/set (.+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const key = match![1];
    const value = match![2];
    await handleAdminSetSetting(bot, msg.chat.id, key, value);
  });

  bot.onText(/\/addbalance (\d+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const targetId = parseInt(match![1]);
    const amount = parseFloat(match![2]);
    if (!isNaN(amount) && amount > 0) {
      await adjustBalance(targetId, amount, 0, "admin_add", `Admin added ${formatUSD(amount)}`);
      await bot.sendMessage(msg.chat.id, `✅ Added ${formatUSD(amount)} to user #${targetId}`);
      try {
        await bot.sendMessage(targetId, `💰 *Admin added ${formatUSD(amount)} to your balance!*`, { parse_mode: "Markdown" });
      } catch { /* user may have blocked bot */ }
    }
  });

  bot.onText(/\/removebalance (\d+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const targetId = parseInt(match![1]);
    const amount = parseFloat(match![2]);
    if (!isNaN(amount) && amount > 0) {
      await adjustBalance(targetId, -amount, 0, "admin_remove", `Admin removed ${formatUSD(amount)}`);
      await bot.sendMessage(msg.chat.id, `✅ Removed ${formatUSD(amount)} from user #${targetId}`);
    }
  });

  bot.onText(/\/ban (\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const targetId = parseInt(match![1]);
    await handleAdminBanUser(bot, msg.chat.id, targetId);
  });

  bot.onText(/\/join(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const gameType = match![1].trim() || undefined;
    await handleQuickJoin(bot, chatId, msg.from!.id, gameType);
  });

  // Quick bet shortcut: /bet dice 0.5
  bot.onText(/\/bet (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    const gameType = match![1].toLowerCase();
    const amount = parseFloat(match![2]);

    const validGames = ["dice", "slots", "rps", "basketball", "bowling", "darts", "football"];
    if (!validGames.includes(gameType)) {
      await bot.sendMessage(chatId, `❌ Invalid game. Valid games: ${validGames.join(", ")}`);
      return;
    }
    if (isNaN(amount) || amount < 0.02) {
      await bot.sendMessage(chatId, "❌ Invalid amount. Minimum bet is $0.02");
      return;
    }

    const mode = msg.chat.type === "private" ? "bot" : "pvp";
    await processBet(bot, chatId, userId, mode, gameType, amount);
  });

  // === CALLBACK QUERIES ===

  bot.on("callback_query", async (callbackQuery) => {
    const msg = callbackQuery.message!;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data || "";

    try {
      await bot.answerCallbackQuery(callbackQuery.id);
    } catch { /* ignore */ }

    // Main menu navigation
    if (data === "back_main") {
      await handlePlay(bot, chatId, userId);
      return;
    }

    if (data === "back_wallet") {
      await handleDeposit(bot, chatId, userId);
      return;
    }

    // Mode select
    if (data === "mode_pvp") {
      await handleModeSelect(bot, chatId, userId, "pvp");
      return;
    }
    if (data === "mode_bot") {
      await handleModeSelect(bot, chatId, userId, "bot");
      return;
    }

    // Game select: game_pvp_dice, game_bot_slots, etc.
    const gameMatch = data.match(/^game_(pvp|bot)_(.+)$/);
    if (gameMatch) {
      const [, mode, gameType] = gameMatch;
      if (gameType === "back") {
        await handlePlay(bot, chatId, userId);
        return;
      }
      await handleGameSelect(bot, chatId, userId, mode, gameType);
      return;
    }

    // Bet select: bet_pvp_dice_0.05, bet_bot_slots_1.00
    const betMatch = data.match(/^bet_(pvp|bot)_(.+)_(.+)$/);
    if (betMatch) {
      const [, mode, gameType, amount] = betMatch;
      await handleBetSelect(bot, chatId, userId, mode, gameType, amount);
      return;
    }

    // Accept bet
    if (data.startsWith("accept_bet_")) {
      const betId = parseInt(data.replace("accept_bet_", ""));
      try {
        const bet = await acceptBet(betId, userId);
        if (!bet) {
          await bot.sendMessage(chatId, "❌ Bet not available or already accepted.");
          return;
        }

        await bot.sendMessage(chatId, `✅ Bet #${betId} accepted! Game starting...\n\nWaiting for dice results...`);

        // Send dice for both players
        const { query } = await import("./db");
        const betRes = await query("SELECT * FROM game_bets WHERE id=$1", [betId]);
        const gameBet = betRes.rows[0];

        const { telegramDiceEmoji, resolveGameByValues, formatDiceResult } = await import("./games/engine");
        const diceEmoji = telegramDiceEmoji(gameBet.game_type);

        if (gameBet.game_type === "rps") {
          // RPS PvP - ask each player for their choice
          const { rpsKeyboard } = await import("./handlers/keyboard");
          await bot.sendMessage(gameBet.creator_id,
            `⚔️ PvP RPS started! Make your choice vs user #${userId}:`,
            { reply_markup: rpsKeyboard(betId, true) }
          );

          await bot.sendMessage(chatId,
            `⚔️ PvP RPS started! Make your choice vs user #${gameBet.creator_id}:`,
            { reply_markup: rpsKeyboard(betId, false) }
          );
          return;
        }

        // Regular dice game
        const creatorDice = await bot.sendDice(gameBet.group_chat_id || chatId, { emoji: diceEmoji });
        await new Promise(r => setTimeout(r, 3500));
        const opponentDice = await bot.sendDice(gameBet.group_chat_id || chatId, { emoji: diceEmoji });
        await new Promise(r => setTimeout(r, 3500));

        const creatorVal = creatorDice.dice!.value;
        const opponentVal = opponentDice.dice!.value;
        const winner = resolveGameByValues(gameBet.game_type, creatorVal, opponentVal);

        const winnerId = winner === "creator" ? gameBet.creator_id : (winner === "draw" ? null : userId);
        await import("./services/gameService").then(gs => gs.completeBet(
          betId,
          formatDiceResult(gameBet.game_type, creatorVal),
          formatDiceResult(gameBet.game_type, opponentVal),
          winnerId
        ));

        const resultMsg = winner === "draw"
          ? `🤝 *DRAW!* Both players refunded.`
          : `🏆 *Player #${winnerId} WINS!*`;

        await bot.sendMessage(gameBet.group_chat_id || chatId, resultMsg, { parse_mode: "Markdown" });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : "Error";
        await bot.sendMessage(chatId, `❌ ${errMsg}`);
      }
      return;
    }

    // Cancel bet
    if (data.startsWith("cancel_bet_")) {
      const betId = parseInt(data.replace("cancel_bet_", ""));
      const betRes = await query("SELECT * FROM game_bets WHERE id=$1 AND status='waiting'", [betId]);
      const bet = betRes.rows[0];
      if (!bet || bet.creator_id !== userId) {
        await bot.sendMessage(chatId, "❌ You can't cancel this bet.");
        return;
      }
      await cancelBet(betId);
      await bot.sendMessage(chatId, `✅ Bet #${betId} cancelled. Funds refunded.`);
      return;
    }

    // RPS choice: rps_creator_betId_choice or rps_opponent_betId_choice
    const rpsMatch = data.match(/^rps_(creator|opponent)_(\d+)_(rock|paper|scissors)$/);
    if (rpsMatch) {
      const [, role, betIdStr, choice] = rpsMatch;
      const betId = parseInt(betIdStr);
      const isCreator = role === "creator";
      await handleRPSChoice(bot, chatId, userId, betId, choice, isCreator);
      return;
    }

    // Stars deposit
    const starsMatch = data.match(/^stars_deposit_(\d+)$/);
    if (starsMatch) {
      await processStarsDeposit(bot, chatId, userId, parseInt(starsMatch[1]));
      return;
    }

    // Wallet actions
    if (data === "wallet_deposit") {
      await handleDeposit(bot, chatId, userId);
      return;
    }
    if (data === "wallet_withdraw") {
      await handleWithdraw(bot, chatId, userId);
      return;
    }
    if (data === "wallet_transactions") {
      await handleTransactionHistory(bot, chatId, userId);
      return;
    }
    if (data === "wallet_pending_stars") {
      await handlePendingStars(bot, chatId, userId);
      return;
    }
    if (data === "deposit_usdt") {
      await handleDepositUSDT(bot, chatId, userId);
      return;
    }
    if (data === "deposit_stars") {
      await handleDepositStars(bot, chatId, userId);
      return;
    }
    if (data === "deposit_ton") {
      await handleDepositTON(bot, chatId, userId);
      return;
    }
    if (data === "withdraw_usdt") {
      await handleWithdrawUSDT(bot, chatId, userId);
      return;
    }
    if (data === "withdraw_history") {
      const wh = await import("./services/withdrawService");
      const history = await wh.getWithdrawHistory(userId, 10);
      if (!history.length) {
        await bot.sendMessage(chatId, "No withdrawal history.");
        return;
      }
      let text = "📋 *Withdrawal History*\n\n";
      for (const w of history) {
        const icon = w.status === "approved" ? "✅" : w.status === "rejected" ? "❌" : "⏳";
        text += `${icon} ${formatUSD(parseFloat(String(w.net_amount)))} — ${w.status}\n`;
      }
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      return;
    }

    // Claim task
    if (data.startsWith("claim_task_")) {
      const taskId = parseInt(data.replace("claim_task_", ""));
      await handleClaimTask(bot, chatId, userId, taskId);
      return;
    }

    // Admin callbacks
    if (isAdmin(userId)) {
      if (data === "admin_profit") {
        await handleAdminProfit(bot, chatId);
        return;
      }
      if (data === "admin_pending_withdrawals") {
        await handleAdminPendingWithdrawals(bot, chatId);
        return;
      }
      if (data === "admin_risk_settings") {
        await handleAdminRiskSettings(bot, chatId);
        return;
      }
      if (data === "admin_user_lookup") {
        await handleAdminUserLookup(bot, chatId);
        return;
      }
      if (data === "admin_recent_games") {
        await handleAdminRecentGames(bot, chatId);
        return;
      }

      const approveMatch = data.match(/^admin_approve_(\d+)$/);
      if (approveMatch) {
        await handleAdminApproveWithdrawal(bot, chatId, parseInt(approveMatch[1]), userId);
        return;
      }

      const rejectMatch = data.match(/^admin_reject_(\d+)$/);
      if (rejectMatch) {
        await handleAdminRejectWithdrawal(bot, chatId, parseInt(rejectMatch[1]));
        return;
      }

      const banMatch = data.match(/^admin_ban_(\d+)$/);
      if (banMatch) {
        await handleAdminBanUser(bot, chatId, parseInt(banMatch[1]));
        return;
      }

      const vipMatch = data.match(/^admin_vip_(\d+)$/);
      if (vipMatch) {
        const targetId = parseInt(vipMatch[1]);
        const u = await getUser(targetId);
        if (u) {
          await query("UPDATE bot_users SET is_vip=$1 WHERE id=$2", [!u.is_vip, targetId]);
          await bot.sendMessage(chatId, `💎 VIP status ${!u.is_vip ? "granted" : "removed"} for user #${targetId}`);
        }
        return;
      }
    }
  });

  // === TEXT MESSAGES (multi-step flows) ===

  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    const text = msg.text.trim();

    // Main menu buttons
    if (text === "🎮 Play") {
      const user = await getUser(userId);
      if (user?.is_banned) {
        await bot.sendMessage(chatId, "🚫 Account suspended.");
        return;
      }
      await handlePlay(bot, chatId, userId);
      return;
    }

    if (text === "💰 Wallet") {
      if (msg.chat.type !== "private") {
        await bot.sendMessage(chatId, "💰 Please use /balance in private chat.");
        return;
      }
      await handleBalance(bot, msg);
      return;
    }

    if (text === "🏆 Leaderboard") {
      await handleLeaderboard(bot, chatId, userId);
      return;
    }

    if (text === "👥 Refer & Earn") {
      await handleReferral(bot, chatId, userId);
      return;
    }

    if (text === "📋 Tasks") {
      await handleTasks(bot, chatId, userId);
      return;
    }

    if (text === "📊 My Stats") {
      await handleBalance(bot, msg);
      return;
    }

    // Multi-step flows based on user state
    const state = userState.get(userId);

    if (state?.step === "enter_custom_bet") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount < 0.02) {
        await bot.sendMessage(chatId, "❌ Invalid amount. Minimum is $0.02");
        return;
      }
      await processBet(bot, chatId, userId, state.mode!, state.gameType!, amount);
      userState.delete(userId);
      return;
    }

    // Deposit amount flow
    const depositState = (global as { __depositState?: Map<number, string> }).__depositState;
    if (depositState?.get(userId) === "enter_usdt_amount") {
      depositState.delete(userId);
      await processUSDTDepositAmount(bot, chatId, userId, text);
      return;
    }

    // Withdraw flow
    if (pendingWithdrawAmount.has(userId)) {
      const amount = pendingWithdrawAmount.get(userId)!;
      pendingWithdrawAmount.delete(userId);
      await processWithdrawAddress(bot, chatId, userId, text, amount);
      return;
    }

    // Check if this is a reply to withdraw amount prompt
    if (msg.reply_to_message?.text?.includes("withdraw you want")) {
      const amount = parseFloat(text);
      if (isNaN(amount)) {
        await bot.sendMessage(chatId, "❌ Invalid amount");
        return;
      }
      pendingWithdrawAmount.set(userId, amount);
      await processWithdrawAmount(bot, chatId, userId, text);
      return;
    }

    // Check if this is a reply to deposit amount prompt
    if (msg.reply_to_message?.text?.includes("deposit in USD")) {
      await processUSDTDepositAmount(bot, chatId, userId, text);
      return;
    }

    // Check if this is a reply to withdraw address prompt
    if (msg.reply_to_message?.text?.includes("wallet address")) {
      // Find the amount from context - try to get from pending flow
      const withdrawState = (global as { __withdrawState?: Map<number, { step: string; amount?: number }> }).__withdrawState;
      const ws = withdrawState?.get(userId);
      if (ws?.amount) {
        withdrawState!.delete(userId);
        await processWithdrawAddress(bot, chatId, userId, text, ws.amount);
      }
      return;
    }

    // Admin user lookup reply
    if (isAdmin(userId) && msg.reply_to_message?.text?.includes("look up")) {
      await handleAdminUserDetail(bot, chatId, text);
      return;
    }
  });

  // === WEBHOOK for OxaPay ===
  // This is handled via HTTP route (see routes/webhook.ts)

  // === BACKGROUND TASKS ===
  // Expire old bets every minute
  setInterval(async () => {
    try {
      await expireOldBets();
    } catch { /* ignore */ }
  }, 60 * 1000);

  // Process locked stars every hour
  setInterval(async () => {
    try {
      await processLockedStars();
    } catch { /* ignore */ }
  }, 60 * 60 * 1000);

  // Expire newbie bonuses daily
  setInterval(async () => {
    try {
      const expired = await query(
        `SELECT id, bonus_balance FROM bot_users 
         WHERE newbie_bonus_given=TRUE 
         AND newbie_bonus_expires_at IS NOT NULL 
         AND newbie_bonus_expires_at < NOW()
         AND bonus_balance > 0`
      );
      for (const user of expired.rows) {
        const bonus = parseFloat(user.bonus_balance);
        await query(
          "UPDATE bot_users SET bonus_balance=0, newbie_bonus_expires_at=NULL, updated_at=NOW() WHERE id=$1",
          [user.id]
        );
        // Record recovered bonus in house stats
        await query(
          `INSERT INTO house_stats (date, recovered_bonus)
           VALUES (CURRENT_DATE, $1)
           ON CONFLICT (date) DO UPDATE SET recovered_bonus = house_stats.recovered_bonus + $1`,
          [bonus]
        );
      }
    } catch { /* ignore */ }
  }, 24 * 60 * 60 * 1000);

  logger.info("Telegram bot initialized successfully!");
  return bot;
}
