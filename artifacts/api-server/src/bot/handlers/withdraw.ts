import TelegramBot from "node-telegram-bot-api";
import { requestWithdrawal } from "../services/withdrawService";
import { getUserBalance } from "../services/userService";
import { calcWithdrawFee, formatUSD, b, i, code } from "../utils";
import { withdrawKeyboard } from "./keyboard";

const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID || "2139807311");

export async function handleWithdraw(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const balance = await getUserBalance(userId);
  const text = `💸 ${b("Withdraw USDT")}\n\n`
    + `💵 Available: ${formatUSD(balance.real)}\n\n`
    + `${b("Fee Structure:")}\n`
    + `• &lt; $2: 15% fee\n`
    + `• $2–$10: 10% fee\n`
    + `• &gt; $10: 8% fee\n\n`
    + `${b("Min withdrawal:")} $0.50\n`
    + `${b("Cooldown:")} 24h between withdrawals\n`
    + `${b("Wager requirement:")} 2x deposit before withdrawal\n\n`
    + `Manual approval: 24–48 hours`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
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
    `💸 ${b("Withdraw USDT")}\n\nYour real balance: ${b(formatUSD(balance.real))}\n\nEnter the amount you want to withdraw:`,
    {
      parse_mode: "HTML",
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
    `💸 ${b("Confirm Withdrawal")}\n\n`
    + `Amount: ${formatUSD(amount)}\n`
    + `Fee: ${formatUSD(fee)} (${(fee / amount * 100).toFixed(0)}%)\n`
    + `You receive: ${b(formatUSD(netAmount))}\n\n`
    + `Now enter your USDT (TRC20/ERC20) wallet address:`,
    {
      parse_mode: "HTML",
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
    await bot.sendMessage(chatId, `❌ ${b("Withdrawal Failed")}\n\n${result.reason}`, { parse_mode: "HTML" });
    return;
  }

  const w = result.withdrawal!;
  const text = `✅ ${b("Withdrawal Request Submitted!")}\n\n`
    + `ID: #${w.id}\n`
    + `Amount: ${formatUSD(parseFloat(String(w.amount)))}\n`
    + `Fee: ${formatUSD(parseFloat(String(w.fee)))}\n`
    + `You receive: ${b(formatUSD(parseFloat(String(w.net_amount))))}\n`
    + `Address: ${code(address)}\n\n`
    + `Status: ⏳ Pending Admin Approval\n`
    + `Processing time: 24–48 hours`;

  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });

  // Notify admin
  try {
    const adminText = `💸 ${b("New Withdrawal Request #" + w.id)}\n\n`
      + `User ID: ${userId}\n`
      + `Amount: ${b(formatUSD(parseFloat(String(w.net_amount))))} (after fee)\n`
      + `Address: ${code(address)}\n`
      + `Network: USDT`;

    await bot.sendMessage(ADMIN_ID, adminText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `admin_approve_${w.id}` },
            { text: "❌ Reject", callback_data: `admin_reject_${w.id}` },
          ],
        ],
      },
    });
  } catch { /* admin may not have started the bot */ }
}
