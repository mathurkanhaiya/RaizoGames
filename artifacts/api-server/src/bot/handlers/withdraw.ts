import TelegramBot from "node-telegram-bot-api";
import { requestWithdrawal, getPendingWithdrawals, approveWithdrawal, rejectWithdrawal } from "../services/withdrawService";
import { getUserBalance } from "../services/userService";
import { calcWithdrawFee, formatUSD } from "../utils";
import { withdrawKeyboard } from "./keyboard";

const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID || "2139807311");

export async function handleWithdraw(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const balance = await getUserBalance(userId);
  const text = `💸 *Withdraw USDT*\n\n`
    + `💵 Available: ${formatUSD(balance.real)}\n\n`
    + `*Fee Structure:*\n`
    + `• < $2: 15% fee\n`
    + `• $2–$10: 10% fee\n`
    + `• > $10: 8% fee\n\n`
    + `*Min withdrawal:* $0.50\n`
    + `*Cooldown:* 24h between withdrawals\n`
    + `*Wager requirement:* 2x deposit before withdrawal\n\n`
    + `Manual approval: 24–48 hours`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: withdrawKeyboard(),
  });
}

export async function handleWithdrawUSDT(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const balance = await getUserBalance(userId);
  if (balance.real < 0.5) {
    await bot.sendMessage(chatId, `❌ Insufficient balance. Minimum withdrawal is $0.50. Your balance: ${formatUSD(balance.real)}`);
    return;
  }

  await bot.sendMessage(chatId,
    `💸 *Withdraw USDT*\n\nYour real balance: *${formatUSD(balance.real)}*\n\nEnter the amount you want to withdraw:`,
    {
      parse_mode: "Markdown",
      reply_markup: { force_reply: true, input_field_placeholder: "Amount (e.g. 5.00)" },
    }
  );
}

export async function processWithdrawAmount(bot: TelegramBot, chatId: number, userId: number, amountStr: string): Promise<void> {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount < 0.5) {
    await bot.sendMessage(chatId, "❌ Minimum withdrawal is $0.50. Please enter a valid amount.");
    return;
  }

  const balance = await getUserBalance(userId);
  if (amount > balance.real) {
    await bot.sendMessage(chatId, `❌ Insufficient balance. Available: ${formatUSD(balance.real)}`);
    return;
  }

  const fee = calcWithdrawFee(amount);
  const netAmount = amount - fee;

  await bot.sendMessage(chatId,
    `💸 *Confirm Withdrawal*\n\n`
    + `Amount: ${formatUSD(amount)}\n`
    + `Fee: ${formatUSD(fee)} (${(fee/amount*100).toFixed(0)}%)\n`
    + `You receive: *${formatUSD(netAmount)}*\n\n`
    + `Now enter your USDT (TRC20/ERC20) wallet address:`,
    {
      parse_mode: "Markdown",
      reply_markup: { force_reply: true, input_field_placeholder: "USDT wallet address" },
    }
  );
}

export async function processWithdrawAddress(bot: TelegramBot, chatId: number, userId: number, address: string, amount: number): Promise<void> {
  if (address.length < 20) {
    await bot.sendMessage(chatId, "❌ Invalid wallet address. Please enter a valid USDT address.");
    return;
  }

  const result = await requestWithdrawal(userId, amount, address);

  if (!result.ok) {
    await bot.sendMessage(chatId, `❌ *Withdrawal Failed*\n\n${result.reason}`, { parse_mode: "Markdown" });
    return;
  }

  const w = result.withdrawal!;
  const text = `✅ *Withdrawal Request Submitted!*\n\n`
    + `ID: #${w.id}\n`
    + `Amount: ${formatUSD(parseFloat(String(w.amount)))}\n`
    + `Fee: ${formatUSD(parseFloat(String(w.fee)))}\n`
    + `You receive: *${formatUSD(parseFloat(String(w.net_amount)))}*\n`
    + `Address: \`${address}\`\n\n`
    + `Status: ⏳ Pending Admin Approval\n`
    + `Processing time: 24–48 hours`;

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });

  // Notify admin
  const adminText = `💸 *New Withdrawal Request #${w.id}*\n\n`
    + `User ID: ${userId}\n`
    + `Amount: ${formatUSD(parseFloat(String(w.net_amount)))} (after fee)\n`
    + `Address: \`${address}\`\n\n`
    + `Network: USDT`;

  await bot.sendMessage(ADMIN_ID, adminText, {
    parse_mode: "Markdown",
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
