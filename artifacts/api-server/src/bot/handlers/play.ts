import TelegramBot from "node-telegram-bot-api";
import { getUserBalance, getUser } from "../services/userService";
import { createBet, completeBet, getWaitingBets } from "../services/gameService";
import { getHouseEdge, isBotPaused, shouldBotLose, getForcePvPAbove } from "../services/riskService";
import { generateBotDiceValue, getRPSBotChoice, formatDiceResult, telegramDiceEmoji, resolveGameByValues } from "../games/engine";
import { formatUSD, getGameEmoji, getRPSEmoji, parseBetAmount, sleep } from "../utils";
import { betAmountKeyboard, modeSelectKeyboard, gameSelectKeyboard, rpsKeyboard } from "./keyboard";

const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID || "2139807311");

// In-memory state for user flows (in production, use Redis)
export const userState: Map<number, {
  step: string;
  gameType?: string;
  mode?: string;
  betAmount?: number;
  betId?: number;
}> = new Map();

export async function handlePlay(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  await bot.sendMessage(chatId, `🎮 *Choose Game Mode*\n\n`
    + `⚔️ *PvP* — Challenge other players in groups\n`
    + `🤖 *vs Bot* — Instant play (private chat)\n\n`
    + `_Bets above $10 are PvP only_`, {
    parse_mode: "Markdown",
    reply_markup: modeSelectKeyboard(),
  });
}

export async function handleModeSelect(bot: TelegramBot, chatId: number, userId: number, mode: "pvp" | "bot"): Promise<void> {
  if (mode === "bot") {
    const paused = await isBotPaused();
    if (paused) {
      await bot.sendMessage(chatId, `⏸ *Bot games are temporarily paused*\n\nDaily payout limit reached. Please play PvP or try again later.`, { parse_mode: "Markdown" });
      return;
    }
  }

  userState.set(userId, { step: "select_game", mode });

  await bot.sendMessage(chatId, `${mode === "pvp" ? "⚔️ PvP Mode" : "🤖 vs Bot"}\n\nSelect a game:`, {
    parse_mode: "Markdown",
    reply_markup: gameSelectKeyboard(mode),
  });
}

export async function handleGameSelect(bot: TelegramBot, chatId: number, userId: number, mode: string, gameType: string): Promise<void> {
  userState.set(userId, { step: "select_bet", gameType, mode });

  await bot.sendMessage(chatId,
    `${getGameEmoji(gameType)} *${gameType.charAt(0).toUpperCase() + gameType.slice(1)}* — ${mode === "pvp" ? "PvP" : "vs Bot"}\n\nChoose your bet amount:`,
    {
      parse_mode: "Markdown",
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

  // Check force PvP
  const forcePvPAbove = await getForcePvPAbove();
  if (amount > forcePvPAbove && mode === "bot") {
    await bot.sendMessage(chatId, `🔒 Bets above ${formatUSD(forcePvPAbove)} must be PvP only.\nUse the group chat to challenge other players.`);
    return;
  }

  const balance = await getUserBalance(userId);
  const totalBalance = balance.real + balance.bonus;

  if (totalBalance < amount) {
    await bot.sendMessage(chatId, `❌ *Insufficient Balance*\n\nYour balance: ${formatUSD(balance.real)}\nRequired: ${formatUSD(amount)}\n\nDeposit with /deposit`, { parse_mode: "Markdown" });
    return;
  }

  if (mode === "bot") {
    await playVsBot(bot, chatId, userId, gameType, amount);
  } else {
    await createPvPBet(bot, chatId, userId, gameType, amount);
  }
}

async function playVsBot(bot: TelegramBot, chatId: number, userId: number, gameType: string, amount: number): Promise<void> {
  try {
    const bet = await createBet(userId, gameType, "bot", amount);
    const botShouldLose = await shouldBotLose(userId);

    if (gameType === "rps") {
      // RPS — ask player for choice
      userState.set(userId, { step: "rps_choice", betId: bet.id, gameType, mode: "bot" });

      await bot.sendMessage(chatId,
        `${getGameEmoji(gameType)} *Rock Paper Scissors*\n\nBet: ${formatUSD(amount)}\n\nMake your choice:`,
        {
          parse_mode: "Markdown",
          reply_markup: rpsKeyboard(bet.id, true),
        }
      );
      return;
    }

    // For dice-type games, send dice
    const diceEmoji = telegramDiceEmoji(gameType);

    await bot.sendMessage(chatId, `${getGameEmoji(gameType)} *${gameType.charAt(0).toUpperCase() + gameType.slice(1)}* — Bet: ${formatUSD(amount)}`, { parse_mode: "Markdown" });

    const playerDiceMsg = await bot.sendDice(chatId, { emoji: diceEmoji });
    const playerValue = playerDiceMsg.dice!.value;

    await sleep(3500); // Wait for dice animation

    const botValue = generateBotDiceValue(gameType, botShouldLose, playerValue);

    await bot.sendMessage(chatId, `🤖 *Bot rolls...*`);
    const botDiceMsg = await bot.sendDice(chatId, { emoji: diceEmoji });

    await sleep(3500);

    const actualBotValue = botDiceMsg.dice!.value;

    // Determine winner using actual dice values
    let winner: "creator" | "opponent" | "draw";
    winner = resolveGameByValues(gameType, playerValue, actualBotValue);

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

    let resultText = `\n━━━━━━━━━━━━━━\n`;
    resultText += `🧑 You: ${playerDisplay}\n`;
    resultText += `🤖 Bot: ${botDisplay}\n\n`;

    if (winner === "creator") {
      resultText += `🏆 *YOU WIN ${formatUSD(payout)}!*\n`;
    } else if (winner === "draw") {
      resultText += `🤝 *DRAW — Refunded!*\n`;
    } else {
      resultText += `💀 *Bot wins. Better luck next time!*\n`;
    }

    resultText += `_(House fee: ${formatUSD(houseFee)})_\n\n`;
    resultText += `💵 Balance: ${formatUSD((await getUserBalance(userId)).real)}`;

    await bot.sendMessage(chatId, resultText, {
      parse_mode: "Markdown",
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
    await bot.sendMessage(chatId, `❌ Error: ${msg}`);
    userState.delete(userId);
  }
}

async function createPvPBet(bot: TelegramBot, chatId: number, userId: number, gameType: string, amount: number): Promise<void> {
  try {
    const bet = await createBet(userId, gameType, "pvp", amount, chatId);

    await bot.sendMessage(chatId,
      `⚔️ *PvP Bet Created!*\n\n`
      + `${getGameEmoji(gameType)} Game: ${gameType.charAt(0).toUpperCase() + gameType.slice(1)}\n`
      + `💰 Bet: ${formatUSD(amount)} each\n`
      + `🏆 Winner gets: ~${formatUSD(amount * 2 * 0.93)}\n`
      + `⏱ Expires in 5 minutes\n\n`
      + `*Bet ID: #${bet.id}*\n\n`
      + `Share this in a group chat for others to accept!`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel Bet", callback_data: `cancel_bet_${bet.id}` }],
          ],
        },
      }
    );

    userState.delete(userId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await bot.sendMessage(chatId, `❌ Error: ${msg}`);
  }
}

export async function handleRPSChoice(bot: TelegramBot, chatId: number, userId: number, betId: number, choice: string, isCreator: boolean): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;

  const state = userState.get(userId);

  if (isCreator && state?.mode === "bot") {
    // Bot mode
    const botShouldLose = await shouldBotLose(userId);
    const botChoice = getRPSBotChoice(choice, botShouldLose);

    const { query } = await import("../db");
    const betRes = await query("SELECT * FROM game_bets WHERE id=$1", [betId]);
    const bet = betRes.rows[0];
    if (!bet) return;

    let winner: "creator" | "opponent" | "draw";
    winner = resolveGameByValues("rps", 0, 0, choice, botChoice);

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

    let resultText = `✊ *Rock Paper Scissors*\n\n`;
    resultText += `🧑 You: ${getRPSEmoji(choice)} ${choice}\n`;
    resultText += `🤖 Bot: ${getRPSEmoji(botChoice)} ${botChoice}\n\n`;

    if (winner === "creator") {
      resultText += `🏆 *YOU WIN ${formatUSD(payout)}!*\n`;
    } else if (winner === "draw") {
      resultText += `🤝 *DRAW — Refunded!*\n`;
    } else {
      resultText += `💀 *Bot wins!*\n`;
    }
    resultText += `_(House fee: ${formatUSD(houseFee)})_\n\n`;
    resultText += `💵 Balance: ${formatUSD((await getUserBalance(userId)).real)}`;

    await bot.sendMessage(chatId, resultText, {
      parse_mode: "Markdown",
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
  const bets = await getWaitingBets(gameType, chatId);
  const available = bets.filter((b) => b.creator_id !== userId);

  if (available.length === 0) {
    await bot.sendMessage(chatId, `🔍 No open bets found${gameType ? ` for ${gameType}` : ""}. Create one with /play!`);
    return;
  }

  let text = `⚡ *Open Bets*\n\n`;
  for (const bet of available.slice(0, 5)) {
    text += `• #${bet.id} ${getGameEmoji(bet.game_type)} ${bet.game_type} — ${formatUSD(parseFloat(String(bet.bet_amount)))} by @${(bet as { username?: string }).username || `user${bet.creator_id}`}\n`;
  }

  const keyboard = available.slice(0, 5).map((b) => ([{
    text: `${getGameEmoji(b.game_type)} #${b.id} — ${formatUSD(parseFloat(String(b.bet_amount)))}`,
    callback_data: `accept_bet_${b.id}`,
  }]));

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}
