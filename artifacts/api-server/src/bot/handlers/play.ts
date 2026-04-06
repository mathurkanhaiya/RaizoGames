import TelegramBot from "node-telegram-bot-api";
import { getUserBalance, getUser } from "../services/userService";
import { createBet, completeBet, getWaitingBets } from "../services/gameService";
import { isBotPaused, shouldBotLose, getForcePvPAbove } from "../services/riskService";
import { generateBotDiceValue, getRPSBotChoice, formatDiceResult, telegramDiceEmoji, resolveGameByValues } from "../games/engine";
import { formatUSD, getGameEmoji, getRPSEmoji, parseBetAmount, sleep, b, i, escapeHtml, safeUserName } from "../utils";
import { sendGameLog } from "../services/logService";
import { betAmountKeyboard, modeSelectKeyboard, gameSelectKeyboard, rpsKeyboard } from "./keyboard";

const BOT_USERNAME = process.env.BOT_USERNAME || "RaizoPvPBot";

// In-memory state for user flows
export const userState: Map<number, {
  step: string;
  gameType?: string;
  mode?: string;
  betAmount?: number;
  betId?: number;
}> = new Map();

export async function handlePlay(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  await bot.sendMessage(chatId,
    `🎮 ${b("Choose Game Mode")}\n\n`
    + `⚔️ ${b("PvP")} — Challenge a real opponent (any chat)\n`
    + `🤖 ${b("vs Bot")} — Instant play against the house\n\n`
    + `${i("Bets above $10 require PvP mode")}`,
    {
      parse_mode: "HTML",
      reply_markup: modeSelectKeyboard(),
    }
  );
}

export async function handleModeSelect(bot: TelegramBot, chatId: number, userId: number, mode: "pvp" | "bot"): Promise<void> {
  if (mode === "bot") {
    const paused = await isBotPaused();
    if (paused) {
      await bot.sendMessage(chatId,
        `⏸ ${b("Bot games are temporarily paused")}\n\nDaily payout limit reached. Please play PvP or try again later.`,
        { parse_mode: "HTML" }
      );
      return;
    }
  }

  userState.set(userId, { step: "select_game", mode });

  await bot.sendMessage(chatId,
    `${mode === "pvp" ? "⚔️ PvP Mode" : "🤖 vs Bot"}\n\nSelect a game:`,
    {
      parse_mode: "HTML",
      reply_markup: gameSelectKeyboard(mode),
    }
  );
}

export async function handleGameSelect(bot: TelegramBot, chatId: number, userId: number, mode: string, gameType: string): Promise<void> {
  userState.set(userId, { step: "select_bet", gameType, mode });

  await bot.sendMessage(chatId,
    `${getGameEmoji(gameType)} ${b(gameType.charAt(0).toUpperCase() + gameType.slice(1))} — ${mode === "pvp" ? "PvP" : "vs Bot"}\n\nChoose your bet amount:`,
    {
      parse_mode: "HTML",
      reply_markup: betAmountKeyboard(gameType, mode),
    }
  );
}

export async function handleBetSelect(bot: TelegramBot, chatId: number, userId: number, mode: string, gameType: string, amountStr: string): Promise<void> {
  if (amountStr === "custom") {
    userState.set(userId, { step: "enter_custom_bet", gameType, mode });
    await bot.sendMessage(chatId, `Enter your custom bet amount (min $0.02):`, {
      reply_markup: { force_reply: true, input_field_placeholder: "e.g. 0.50" },
    });
    return;
  }

  const amount = parseBetAmount(amountStr);
  if (!amount) {
    await bot.sendMessage(chatId, "❌ Invalid bet amount.");
    return;
  }

  await processBet(bot, chatId, userId, mode, gameType, amount);
}

export async function processBet(bot: TelegramBot, chatId: number, userId: number, mode: string, gameType: string, amount: number): Promise<void> {
  if (amount < 0.02) {
    await bot.sendMessage(chatId, "❌ Minimum bet is $0.02");
    return;
  }

  const forcePvPAbove = await getForcePvPAbove();
  if (amount > forcePvPAbove && mode === "bot") {
    await bot.sendMessage(chatId, `🔒 Bets above ${formatUSD(forcePvPAbove)} must be PvP.\nUse /play and select PvP mode.`);
    return;
  }

  const balance = await getUserBalance(userId);
  const totalBalance = balance.real + balance.bonus;

  if (totalBalance < amount) {
    await bot.sendMessage(chatId,
      `❌ ${b("Insufficient Balance")}\n\nYour balance: ${formatUSD(balance.real)}\nRequired: ${formatUSD(amount)}\n\nDeposit with /deposit`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (mode === "bot") {
    await playVsBot(bot, chatId, userId, gameType, amount);
  } else {
    // Detect if this is a group chat or private chat
    const isGroup = chatId < 0;
    await createPvPBet(bot, chatId, userId, gameType, amount, isGroup);
  }
}

async function playVsBot(bot: TelegramBot, chatId: number, userId: number, gameType: string, amount: number): Promise<void> {
  try {
    const bet = await createBet(userId, gameType, "bot", amount);
    const botShouldLose = await shouldBotLose(userId);

    if (gameType === "rps") {
      userState.set(userId, { step: "rps_choice", betId: bet.id, gameType, mode: "bot" });

      await bot.sendMessage(chatId,
        `${getGameEmoji(gameType)} ${b("Rock Paper Scissors")}\n\nBet: ${formatUSD(amount)}\n\nMake your choice:`,
        {
          parse_mode: "HTML",
          reply_markup: rpsKeyboard(bet.id, true),
        }
      );
      return;
    }

    const diceEmoji = telegramDiceEmoji(gameType);

    await bot.sendMessage(chatId,
      `${getGameEmoji(gameType)} ${b(gameType.charAt(0).toUpperCase() + gameType.slice(1))} — Bet: ${formatUSD(amount)}`,
      { parse_mode: "HTML" }
    );

    const playerDiceMsg = await bot.sendDice(chatId, { emoji: diceEmoji });
    const playerValue = playerDiceMsg.dice!.value;

    await sleep(3500);

    await bot.sendMessage(chatId, `🤖 ${b("Bot rolls...")}`, { parse_mode: "HTML" });
    const botDiceMsg = await bot.sendDice(chatId, { emoji: diceEmoji });

    await sleep(3500);

    const actualBotValue = botDiceMsg.dice!.value;
    const winner = resolveGameByValues(gameType, playerValue, actualBotValue);

    const playerDisplay = formatDiceResult(gameType, playerValue);
    const botDisplay = formatDiceResult(gameType, actualBotValue);

    const completedBet = await completeBet(
      bet.id,
      playerDisplay,
      botDisplay,
      winner === "creator" ? userId : (winner === "draw" ? null : -1)
    );

    const houseFee = parseFloat(String(completedBet.house_fee));
    const payout = parseFloat(String(completedBet.payout));
    const netProfit = winner === "creator" ? payout - amount : 0;

    // Log to channel
    sendGameLog({
      gameType,
      mode: "bot",
      betAmount: amount,
      creatorId: userId,
      creatorResult: playerDisplay,
      opponentResult: botDisplay,
      winnerId: winner === "creator" ? userId : (winner === "draw" ? null : -1),
      payout,
      houseFee,
    }).catch(() => {});

    let resultText = `\n━━━━━━━━━━━━━━\n`;
    resultText += `🧑 You: ${playerDisplay}\n`;
    resultText += `🤖 Bot: ${botDisplay}\n\n`;

    if (winner === "creator") {
      resultText += `🏆 ${b("YOU WIN!")} +${formatUSD(netProfit)}\n`;
      resultText += `${i("Fee: " + formatUSD(houseFee))}\n`;
    } else if (winner === "draw") {
      resultText += `🤝 ${b("DRAW — Bet refunded!")}\n`;
    } else {
      resultText += `💀 ${b("Bot wins.")} -${formatUSD(amount)}\n`;
    }

    const newBalance = await getUserBalance(userId);
    resultText += `\n💵 Balance: ${formatUSD(newBalance.real)}`;

    await bot.sendMessage(chatId, resultText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔁 Play Again", callback_data: `bet_bot_${gameType}_${amount}` },
            { text: "🎮 Main Menu", callback_data: "back_main" },
          ],
        ],
      },
    });

    userState.delete(userId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await bot.sendMessage(chatId, `❌ Error: ${escapeHtml(msg)}`);
    userState.delete(userId);
  }
}

async function createPvPBet(bot: TelegramBot, chatId: number, userId: number, gameType: string, amount: number, isGroup: boolean): Promise<void> {
  try {
    // Only store groupChatId if this is an actual group — not a private chat
    const groupChatId = isGroup ? chatId : undefined;
    const bet = await createBet(userId, gameType, "pvp", amount, groupChatId);

    const winnerAmount = formatUSD(amount * 2 * 0.93);
    const gameLabel = gameType.charAt(0).toUpperCase() + gameType.slice(1);

    // Deep link anyone can tap to accept (works in private and group)
    const acceptLink = `https://t.me/${BOT_USERNAME}?start=accept_${bet.id}`;

    let msg = `⚔️ ${b("PvP Bet Created!")}\n\n`
      + `${getGameEmoji(gameType)} Game: ${gameLabel}\n`
      + `💰 Bet: ${formatUSD(amount)} each\n`
      + `🏆 Winner gets: ~${winnerAmount}\n`
      + `⏱ Expires in 5 minutes\n`
      + `${b("Bet ID: #" + bet.id)}\n\n`;

    if (isGroup) {
      msg += `${i("Tap the button below to accept!")}`;
    } else {
      msg += `${i("Share the link below so someone can challenge you!")}`;
    }

    const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

    if (isGroup) {
      // In group: show accept button right there
      keyboard.push([{ text: `⚔️ Accept Bet — ${formatUSD(amount)}`, callback_data: `accept_bet_${bet.id}` }]);
    } else {
      // In private: show share link + accept link others can open
      keyboard.push([{
        text: "📤 Share to get opponent",
        url: `https://t.me/share/url?url=${encodeURIComponent(acceptLink)}&text=${encodeURIComponent(
          `⚔️ I challenged you to ${gameLabel} on RAIZO GAMES!\nBet: ${formatUSD(amount)} each — Winner gets ~${winnerAmount}\nTap to accept: `
        )}`,
      }]);
      keyboard.push([{ text: "👥 Find Open Bets", callback_data: "find_pvp_bets" }]);
    }

    keyboard.push([{ text: "❌ Cancel Bet", callback_data: `cancel_bet_${bet.id}` }]);

    await bot.sendMessage(chatId, msg, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });

    userState.delete(userId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await bot.sendMessage(chatId, `❌ Error: ${escapeHtml(msg)}`);
  }
}

export async function handleRPSChoice(bot: TelegramBot, chatId: number, userId: number, betId: number, choice: string, isCreator: boolean): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;

  const state = userState.get(userId);

  if (isCreator && state?.mode === "bot") {
    const botShouldLose = await shouldBotLose(userId);
    const botChoice = getRPSBotChoice(choice, botShouldLose);

    const { query } = await import("../db");
    const betRes = await query("SELECT * FROM game_bets WHERE id=$1", [betId]);
    const bet = betRes.rows[0];
    if (!bet) return;

    const winner = resolveGameByValues("rps", 0, 0, choice, botChoice);

    const completedBet = await completeBet(
      betId,
      choice,
      botChoice,
      winner === "creator" ? userId : (winner === "draw" ? null : -1),
      choice,
      botChoice
    );

    const payout = parseFloat(String(completedBet.payout));
    const houseFee = parseFloat(String(completedBet.house_fee));
    const betAmt = parseFloat(String(bet.bet_amount));
    const netProfit = winner === "creator" ? payout - betAmt : 0;

    // Log to channel
    sendGameLog({
      gameType: "rps",
      mode: "bot",
      betAmount: betAmt,
      creatorId: userId,
      creatorResult: choice,
      opponentResult: botChoice,
      winnerId: winner === "creator" ? userId : (winner === "draw" ? null : -1),
      payout,
      houseFee,
    }).catch(() => {});

    let resultText = `✊ ${b("Rock Paper Scissors")}\n\n`;
    resultText += `🧑 You: ${getRPSEmoji(choice)} ${choice}\n`;
    resultText += `🤖 Bot: ${getRPSEmoji(botChoice)} ${botChoice}\n\n`;

    if (winner === "creator") {
      resultText += `🏆 ${b("YOU WIN!")} +${formatUSD(netProfit)}\n`;
      resultText += `${i("Fee: " + formatUSD(houseFee))}\n`;
    } else if (winner === "draw") {
      resultText += `🤝 ${b("DRAW — Bet refunded!")}\n`;
    } else {
      resultText += `💀 ${b("Bot wins.")} -${formatUSD(betAmt)}\n`;
    }

    const newBal = await getUserBalance(userId);
    resultText += `\n💵 Balance: ${formatUSD(newBal.real)}`;

    await bot.sendMessage(chatId, resultText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔁 Play Again", callback_data: `game_bot_rps` },
            { text: "🎮 Main Menu", callback_data: "back_main" },
          ],
        ],
      },
    });

    userState.delete(userId);
  }
}

export async function handleQuickJoin(bot: TelegramBot, chatId: number, userId: number, gameType?: string): Promise<void> {
  const bets = await getWaitingBets(gameType);
  const available = bets.filter((bet) => bet.creator_id !== userId);

  if (available.length === 0) {
    await bot.sendMessage(chatId, `🔍 No open bets right now${gameType ? ` for ${gameType}` : ""}.\n\nCreate one with /play!`);
    return;
  }

  let text = `⚡ ${b("Open PvP Bets")}\n\n`;
  for (const bet of available.slice(0, 5)) {
    const displayName = escapeHtml(
      (bet as { username?: string }).username
        ? `@${(bet as { username?: string }).username}`
        : `Player#${bet.creator_id}`
    );
    text += `• #${bet.id} ${getGameEmoji(bet.game_type)} ${bet.game_type} — ${formatUSD(parseFloat(String(bet.bet_amount)))} by ${displayName}\n`;
  }

  const keyboard = available.slice(0, 5).map((bet) => ([{
    text: `${getGameEmoji(bet.game_type)} #${bet.id} — ${formatUSD(parseFloat(String(bet.bet_amount)))} — Accept`,
    callback_data: `accept_bet_${bet.id}`,
  }]));

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// Accept a PvP bet by ID — used from deep link `/start accept_<betId>`
export async function handleAcceptFromDeepLink(bot: TelegramBot, chatId: number, userId: number, betId: number): Promise<void> {
  const { query } = await import("../db");
  const betRes = await query(
    "SELECT gb.*, u.username, u.first_name FROM game_bets gb JOIN bot_users u ON gb.creator_id=u.id WHERE gb.id=$1 AND gb.status='waiting'",
    [betId]
  );
  const bet = betRes.rows[0];

  if (!bet) {
    await bot.sendMessage(chatId, "❌ Bet not found or already accepted.");
    return;
  }
  if (bet.creator_id === userId) {
    await bot.sendMessage(chatId, "❌ You can't accept your own bet!");
    return;
  }

  const creatorName = escapeHtml(bet.username ? `@${bet.username}` : bet.first_name || `Player#${bet.creator_id}`);
  const gameLabel = bet.game_type.charAt(0).toUpperCase() + bet.game_type.slice(1);

  await bot.sendMessage(chatId,
    `⚔️ ${b("PvP Challenge!")}\n\n`
    + `From: ${creatorName}\n`
    + `Game: ${getGameEmoji(bet.game_type)} ${gameLabel}\n`
    + `Bet: ${formatUSD(parseFloat(bet.bet_amount))} each\n`
    + `Winner gets: ~${formatUSD(parseFloat(bet.bet_amount) * 2 * 0.93)}\n\n`
    + `${i("Do you accept?")}`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: `✅ Accept — ${formatUSD(parseFloat(bet.bet_amount))}`, callback_data: `accept_bet_${betId}` },
            { text: "❌ Decline", callback_data: "back_main" },
          ],
        ],
      },
    }
  );
}
