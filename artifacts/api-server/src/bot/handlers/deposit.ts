import TelegramBot from "node-telegram-bot-api";
import { createOxaPayInvoice, recordStarsDeposit, getPendingStars } from "../services/depositService";
import { formatUSD, formatDate } from "../utils";
import { depositKeyboard } from "./keyboard";

const TON_WALLET = process.env.TON_WALLET || "UQDqFSJ_gNtlwbRPmoJmEbJ4yxomqJNSJzDWdI6Dg-pQRNzL";
const MIN_STARS = 20;

export async function handleDeposit(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const text = `📥 *Deposit Funds*\n\n`
    + `Choose your preferred deposit method:\n\n`
    + `💵 *USDT* — Automatic, instant credit\n`
    + `⭐ *Stars* — 1 ⭐ = $0.01, 21-day lock\n`
    + `⚡ *TON* — Manual, requires comment\n\n`
    + `_Min deposit: $1 USDT_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: depositKeyboard(),
  });
}

export async function handleDepositUSDT(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  await bot.sendMessage(chatId, "💵 *USDT Deposit*\n\nEnter the amount in USD you want to deposit:\n_(Example: 5, 10, 50)_", {
    parse_mode: "Markdown",
    reply_markup: { force_reply: true, input_field_placeholder: "Amount in USD" },
  });
}

export async function processUSDTDepositAmount(bot: TelegramBot, chatId: number, userId: number, amountStr: string): Promise<void> {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount < 1) {
    await bot.sendMessage(chatId, "❌ Minimum deposit is $1.00 USDT. Please enter a valid amount.");
    return;
  }
  if (amount > 10000) {
    await bot.sendMessage(chatId, "❌ Maximum single deposit is $10,000 USDT.");
    return;
  }

  await bot.sendMessage(chatId, "⏳ Generating payment link...");

  const invoice = await createOxaPayInvoice(userId, amount);
  if (!invoice) {
    await bot.sendMessage(chatId, "❌ Failed to create invoice. Please try again later.");
    return;
  }

  const text = `💵 *USDT Deposit — ${formatUSD(amount)}*\n\n`
    + `Click the button below to pay:\n`
    + `Order ID: \`${invoice.orderId}\`\n\n`
    + `✅ Your balance will be credited automatically after confirmation.\n`
    + `⏱ Payment link expires in 30 minutes.`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 Pay Now", url: invoice.payUrl }],
        [{ text: "« Back to Wallet", callback_data: "back_wallet" }],
      ],
    },
  });
}

export async function handleDepositTON(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const text = `⚡ *TON Deposit*\n\n`
    + `Send TON to the following address:\n\n`
    + `\`${TON_WALLET}\`\n\n`
    + `⚠️ *IMPORTANT:* Include your User ID as the comment/memo:\n`
    + `\`${userId}\`\n\n`
    + `📋 Conversion rate updated daily\n`
    + `⏱ Auto-credited within 1-3 blockchain confirmations\n\n`
    + `_Without the correct comment, your deposit cannot be tracked!_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "« Back", callback_data: "wallet_deposit" }],
      ],
    },
  });
}

export async function handleDepositStars(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const text = `⭐ *Telegram Stars Deposit*\n\n`
    + `• 1 ⭐ = $0.01 USD\n`
    + `• Minimum: ${MIN_STARS} Stars ($${MIN_STARS * 0.01})\n`
    + `• 🔒 21-Day Lock — credited after 21 days\n`
    + `• Anti-scam protection enabled\n\n`
    + `Enter the number of Stars you want to deposit:`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⭐ 20 Stars", callback_data: `stars_deposit_20` },
          { text: "⭐ 50 Stars", callback_data: `stars_deposit_50` },
          { text: "⭐ 100 Stars", callback_data: `stars_deposit_100` },
        ],
        [{ text: "« Back", callback_data: "wallet_deposit" }],
      ],
    },
  });
}

export async function processStarsDeposit(bot: TelegramBot, chatId: number, userId: number, starsCount: number): Promise<void> {
  if (starsCount < MIN_STARS) {
    await bot.sendMessage(chatId, `❌ Minimum is ${MIN_STARS} Stars.`);
    return;
  }

  const result = await recordStarsDeposit(userId, starsCount);

  const text = `⭐ *Stars Deposit Recorded*\n\n`
    + `• Stars: ${starsCount} ⭐\n`
    + `• USD Value: ${formatUSD(result.usdAmount)}\n`
    + `• 🔒 Locked Until: ${formatDate(result.lockedUntil)}\n\n`
    + `Your balance will be credited automatically after the 21-day lock period.\n`
    + `Use /balance to check pending stars.`;

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

export async function handlePendingStars(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const pending = await getPendingStars(userId);

  if (pending.length === 0) {
    await bot.sendMessage(chatId, "⭐ No pending Stars deposits.");
    return;
  }

  let text = `⭐ *Pending Stars Deposits*\n\n`;
  for (const dep of pending) {
    const timeLeft = new Date(dep.locked_until!).getTime() - Date.now();
    const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
    text += `• ${dep.stars_count} ⭐ = ${formatUSD(parseFloat(String(dep.usd_amount)))}\n`;
    text += `  Unlocks in: *${daysLeft} days*\n\n`;
  }

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}
