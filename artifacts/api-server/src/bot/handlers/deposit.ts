import TelegramBot from "node-telegram-bot-api";
import { createOxaPayInvoice, recordStarsDeposit, getPendingStars } from "../services/depositService";
import { formatUSD, formatDate, b, i, code } from "../utils";
import { depositKeyboard } from "./keyboard";

const TON_WALLET = process.env.TON_WALLET || "UQDqFSJ_gNtlwbRPmoJmEbJ4yxomqJNSJzDWdI6Dg-pQRNzL";
const MIN_STARS = 20;

export async function handleDeposit(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const text = `📥 ${b("Deposit Funds")}\n\n`
    + `Choose your preferred deposit method:\n\n`
    + `💵 ${b("USDT")} — Automatic, instant credit\n`
    + `⭐ ${b("Stars")} — 1 ⭐ = $0.01, 21-day lock\n`
    + `⚡ ${b("TON")} — Manual, requires comment\n\n`
    + `${i("Min deposit: $1 USDT")}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: depositKeyboard(),
  });
}

export async function handleDepositUSDT(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  await bot.sendMessage(chatId,
    `💵 ${b("USDT Deposit")}\n\nEnter the amount in USD you want to deposit:\n${i("Example: 5, 10, 50")}`,
    {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, input_field_placeholder: "Amount in USD" },
    }
  );
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

  const text = `💵 ${b("USDT Deposit — " + formatUSD(amount))}\n\n`
    + `Click the button below to pay:\n`
    + `Order ID: ${code(invoice.orderId)}\n\n`
    + `✅ Your balance will be credited automatically after confirmation.\n`
    + `⏱ Payment link expires in 30 minutes.`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 Pay Now", url: invoice.payUrl }],
        [{ text: "« Back to Wallet", callback_data: "back_wallet" }],
      ],
    },
  });
}

export async function handleDepositTON(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const text = `⚡ ${b("TON Deposit")}\n\n`
    + `Send TON to the following address:\n\n`
    + `${code(TON_WALLET)}\n\n`
    + `⚠️ ${b("IMPORTANT:")} Include your User ID as the comment/memo:\n`
    + `${code(String(userId))}\n\n`
    + `📋 Conversion rate updated daily\n`
    + `⏱ Auto-credited within 1-3 blockchain confirmations\n\n`
    + `${i("Without the correct comment, your deposit cannot be tracked!")}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "« Back", callback_data: "wallet_deposit" }],
      ],
    },
  });
}

export async function handleDepositStars(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const text = `⭐ ${b("Telegram Stars Deposit")}\n\n`
    + `• 1 ⭐ = $0.01 USD\n`
    + `• Minimum: ${MIN_STARS} Stars ($${MIN_STARS * 0.01})\n`
    + `• 🔒 21-Day Lock — credited after 21 days\n`
    + `• Anti-scam protection enabled\n\n`
    + `Choose how many Stars to deposit:`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⭐ 20 Stars", callback_data: `stars_invoice_20` },
          { text: "⭐ 50 Stars", callback_data: `stars_invoice_50` },
          { text: "⭐ 100 Stars", callback_data: `stars_invoice_100` },
        ],
        [
          { text: "⭐ 250 Stars", callback_data: `stars_invoice_250` },
          { text: "⭐ 500 Stars", callback_data: `stars_invoice_500` },
        ],
        [{ text: "« Back", callback_data: "wallet_deposit" }],
      ],
    },
  });
}

// Send a real Telegram Stars (XTR) invoice
export async function sendStarsInvoice(bot: TelegramBot, chatId: number, userId: number, starsCount: number): Promise<void> {
  if (starsCount < MIN_STARS) {
    await bot.sendMessage(chatId, `❌ Minimum is ${MIN_STARS} Stars.`);
    return;
  }

  const usdValue = starsCount * 0.01;
  const payload = `stars_${userId}_${starsCount}_${Date.now()}`;

  try {
    await bot.sendInvoice(
      chatId,
      "⭐ RAIZO GAMES — Stars Deposit",
      `Deposit ${starsCount} Telegram Stars to your RAIZO GAMES balance.\n\n` +
        `Value: $${usdValue.toFixed(2)} USD\n` +
        `⚠️ 21-day lock applies before funds are credited.`,
      payload,
      "", // provider_token — empty string for XTR (Stars)
      "XTR", // currency = Telegram Stars
      [{ label: `${starsCount} Stars Deposit`, amount: starsCount }]
    );
  } catch (err) {
    await bot.sendMessage(chatId, "❌ Failed to create Stars invoice. Please try again.");
  }
}

// Called after successful Stars payment
export async function handleSuccessfulStarsPayment(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  payload: string,
  telegramPaymentChargeId: string
): Promise<void> {
  // Parse payload: stars_userId_starsCount_timestamp
  const parts = payload.split("_");
  if (parts.length < 3 || parts[0] !== "stars") return;

  const starsCount = parseInt(parts[2]);
  if (isNaN(starsCount) || starsCount < MIN_STARS) return;

  const result = await recordStarsDeposit(userId, starsCount, telegramPaymentChargeId);

  const text = `✅ ${b("Stars Payment Received!")}\n\n`
    + `• Stars: ${starsCount} ⭐\n`
    + `• USD Value: ${formatUSD(result.usdAmount)}\n`
    + `• 🔒 Credited on: ${i(formatDate(result.lockedUntil))}\n\n`
    + `Your balance will be credited automatically after the 21-day lock period.\n`
    + `Check /balance to see pending Stars deposits.`;

  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}

export async function handlePendingStars(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const pending = await getPendingStars(userId);

  if (pending.length === 0) {
    await bot.sendMessage(chatId, "⭐ No pending Stars deposits.");
    return;
  }

  let text = `⭐ ${b("Pending Stars Deposits")}\n\n`;
  for (const dep of pending) {
    const timeLeft = new Date(dep.locked_until!).getTime() - Date.now();
    const daysLeft = Math.max(0, Math.ceil(timeLeft / (24 * 60 * 60 * 1000)));
    text += `• ${dep.stars_count} ⭐ = ${formatUSD(parseFloat(String(dep.usd_amount)))}\n`;
    text += `  Unlocks in: ${b(daysLeft + " days")}\n\n`;
  }

  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}
