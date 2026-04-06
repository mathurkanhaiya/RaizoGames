import TelegramBot from "node-telegram-bot-api";
import { createOxaPayInvoice, recordStarsDeposit } from "../services/depositService";
import { formatUSD, b, i, code } from "../utils";
import { depositKeyboard } from "./keyboard";

export const MIN_STARS = 5;
export const MIN_DEPOSIT_USD = 0.10;

export async function handleDeposit(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const text = `📥 ${b("Deposit Funds")}\n\n`
    + `Choose your deposit method:\n\n`
    + `💵 ${b("USDT")} — Automatic · Instant credit\n`
    + `⭐ ${b("Stars")} — 1 ⭐ = $0.01 · Instant credit\n\n`
    + `${i("Min deposit: $" + MIN_DEPOSIT_USD.toFixed(2) + " USDT | " + MIN_STARS + " Stars")}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: depositKeyboard(),
  });
}

export async function handleDepositUSDT(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  await bot.sendMessage(chatId,
    `💵 ${b("USDT Deposit")}\n\nEnter the amount in USD you want to deposit:\n${i("Min: $" + MIN_DEPOSIT_USD.toFixed(2) + " — Example: 0.1, 1, 5, 10, 50")}`,
    {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, input_field_placeholder: "Amount in USD (min $0.10)" },
    }
  );
}

export async function processUSDTDepositAmount(bot: TelegramBot, chatId: number, userId: number, amountStr: string): Promise<void> {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount < MIN_DEPOSIT_USD) {
    await bot.sendMessage(chatId, `❌ Minimum USDT deposit is $${MIN_DEPOSIT_USD.toFixed(2)}. Please enter a valid amount.`);
    return;
  }
  if (amount > 10000) {
    await bot.sendMessage(chatId, "❌ Maximum single deposit is $10,000 USDT.");
    return;
  }

  await bot.sendMessage(chatId, "⏳ Generating your payment link...");

  const invoice = await createOxaPayInvoice(userId, amount);
  if (!invoice) {
    await bot.sendMessage(chatId,
      `❌ ${b("Failed to create invoice")}\n\nThe payment gateway rejected this request.\n\nTry a higher amount or contact @RaizoGamesSupport for help.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const text =
    `✅ ${b("Payment Created!")}\n\n`
    + `🆔 ${b("Payment ID:")} ${code(invoice.orderId)}\n`
    + `💰 ${b("Amount:")} $${amount.toFixed(2)} USD\n`
    + `🔗 ${b("Payment Link:")} <a href="${invoice.payUrl}">Pay Now</a>\n\n`
    + `📩 ${i("Note: If you've sent the payment and it's not reflected or you face any issues, contact @RaizoGamesSupport for support.")}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 Pay Now", url: invoice.payUrl }],
        [{ text: "❌ Cancel Deposit", callback_data: "back_wallet" }],
      ],
    },
  });
}

export async function handleDepositStars(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const text = `⭐ ${b("Telegram Stars Deposit")}\n\n`
    + `• 1 ⭐ = $0.01 USD\n`
    + `• Minimum: ${MIN_STARS} Stars ($${(MIN_STARS * 0.01).toFixed(2)})\n`
    + `• ✅ Instant credit — no waiting period\n\n`
    + `Choose a preset or enter a custom amount:`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: `⭐ ${MIN_STARS}`, callback_data: `stars_invoice_${MIN_STARS}` },
          { text: "⭐ 20", callback_data: "stars_invoice_20" },
          { text: "⭐ 50", callback_data: "stars_invoice_50" },
        ],
        [
          { text: "⭐ 100", callback_data: "stars_invoice_100" },
          { text: "⭐ 250", callback_data: "stars_invoice_250" },
          { text: "⭐ 500", callback_data: "stars_invoice_500" },
        ],
        [{ text: "✏️ Custom Amount", callback_data: "stars_custom_amount" }],
        [{ text: "« Back", callback_data: "wallet_deposit" }],
      ],
    },
  });
}

export async function handleStarsCustomAmount(bot: TelegramBot, chatId: number): Promise<void> {
  await bot.sendMessage(chatId,
    `⭐ ${b("Custom Stars Amount")}\n\nEnter the number of Stars to deposit:\n${i("Min: " + MIN_STARS + " Stars")}`,
    {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, input_field_placeholder: `Min ${MIN_STARS} Stars` },
    }
  );
}

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
      `Deposit ${starsCount} Telegram Stars to your RAIZO GAMES balance.\n\nValue: $${usdValue.toFixed(2)} USD\n✅ Instant credit after payment.`,
      payload,
      "",    // provider_token — empty for XTR (Stars)
      "XTR",
      [{ label: `${starsCount} Stars Deposit`, amount: starsCount }]
    );
  } catch (err) {
    await bot.sendMessage(chatId, "❌ Failed to create Stars invoice. Please try again.");
  }
}

// Called after successful Stars payment confirmation from Telegram
export async function handleSuccessfulStarsPayment(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  payload: string,
  telegramPaymentChargeId: string
): Promise<void> {
  const parts = payload.split("_");
  if (parts.length < 3 || parts[0] !== "stars") return;

  const starsCount = parseInt(parts[2]);
  if (isNaN(starsCount) || starsCount < MIN_STARS) return;

  const result = await recordStarsDeposit(userId, starsCount, telegramPaymentChargeId);

  const text = `✅ ${b("Stars Payment Received!")}\n\n`
    + `⭐ Stars: ${starsCount}\n`
    + `💰 Credited: ${formatUSD(result.usdAmount)}\n\n`
    + `Your balance has been updated instantly. Use /balance to check.`;

  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}
