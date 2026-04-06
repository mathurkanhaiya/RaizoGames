import TelegramBot from "node-telegram-bot-api";
import { getUser } from "../services/userService";
import { getDepositHistory } from "../services/depositService";
import { getWithdrawHistory } from "../services/withdrawService";
import { formatUSD, formatDate, b, i } from "../utils";
import { walletKeyboard } from "./keyboard";

export async function handleBalance(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const userId = msg.from!.id;

  const user = await getUser(userId);
  if (!user) {
    await bot.sendMessage(chatId, "Please start the bot first with /start");
    return;
  }

  const real = parseFloat(String(user.real_balance));
  const bonus = parseFloat(String(user.bonus_balance));
  const wagerReq = parseFloat(String(user.wager_requirement));
  const bonusWagerReq = parseFloat(String(user.bonus_wager_requirement));

  let text = `💰 ${b("Your Wallet")}\n\n`;
  text += `💵 ${b("Real Balance:")} ${formatUSD(real)}\n`;
  if (bonus > 0) {
    text += `🎁 ${b("Bonus Balance:")} ${formatUSD(bonus)}\n`;
  }
  text += `\n📊 ${b("Stats:")}\n`;
  text += `• Total Deposited: ${formatUSD(parseFloat(String(user.total_deposited)))}\n`;
  text += `• Total Wagered: ${formatUSD(parseFloat(String(user.total_wagered)))}\n`;
  text += `• Total Withdrawn: ${formatUSD(parseFloat(String(user.total_withdrawn)))}\n`;

  if (wagerReq > 0) {
    text += `\n⚠️ ${b("Wager Requirement:")} ${formatUSD(wagerReq)} remaining\n`;
  }
  if (bonusWagerReq > 0) {
    text += `🎁 ${b("Bonus Wager Req:")} ${formatUSD(bonusWagerReq)} remaining\n`;
  }

  if (user.is_vip) {
    text += `\n💎 ${b("VIP Status:")} Active (Reduced fees)\n`;
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: walletKeyboard(),
  });
}

export async function handleTransactionHistory(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const deposits = await getDepositHistory(userId, 5);
  const withdrawals = await getWithdrawHistory(userId, 5);

  let text = `🧾 ${b("Recent Transactions")}\n\n`;

  if (deposits.length > 0) {
    text += `${b("Deposits:")}\n`;
    for (const dep of deposits) {
      const icon = dep.status === "confirmed" ? "✅" : "⏳";
      const method = dep.method === "stars" ? `⭐ Stars` : dep.method.toUpperCase();
      text += `${icon} ${method}: ${formatUSD(parseFloat(String(dep.usd_amount)))} — ${dep.status}\n`;
      text += `   ${i(formatDate(new Date(dep.created_at)))}\n`;
    }
  } else {
    text += `No deposits yet.\n`;
  }

  text += `\n${b("Withdrawals:")}\n`;
  if (withdrawals.length > 0) {
    for (const w of withdrawals) {
      const icon = w.status === "approved" ? "✅" : w.status === "rejected" ? "❌" : "⏳";
      text += `${icon} ${formatUSD(parseFloat(String(w.net_amount)))} (fee: ${formatUSD(parseFloat(String(w.fee)))}) — ${w.status}\n`;
      text += `   ${i(formatDate(new Date(w.created_at)))}\n`;
    }
  } else {
    text += `No withdrawals yet.\n`;
  }

  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}
