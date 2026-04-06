import TelegramBot from "node-telegram-bot-api";
import { getOrCreateUser, giveNewbieBonus } from "../services/userService";
import { formatUSD, escapeHtml, b, i } from "../utils";
import { mainMenuKeyboard } from "./keyboard";

export async function handleStart(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const user = msg.from;
  if (!user) return;

  const text = msg.text || "";
  const parts = text.split(" ");
  const referralCode = parts.length > 1 ? parts[1] : undefined;

  try {
    const dbUser = await getOrCreateUser(
      user.id,
      user.username,
      user.first_name,
      user.last_name,
      referralCode
    );

    const isNew = Date.now() - new Date(dbUser.created_at).getTime() < 5000;
    const name = escapeHtml(user.first_name || "Player");

    let welcomeText = "";

    if (isNew) {
      const bonus = await giveNewbieBonus(user.id);
      welcomeText = `🎰 ${b("Welcome to RAIZO GAMES, " + name + "!")}\n\n`;
      welcomeText += `🔥 ${b("PvP Casino Bot")} — Fast. Secure. Competitive.\n\n`;
      welcomeText += `🎁 ${b("Newbie Bonus:")} ${formatUSD(bonus)} USDT added to your account!\n`;
      welcomeText += `${i("(Bonus expires in 7 days. 7x wager required to withdraw winnings.)")}\n\n`;
      welcomeText += `━━━━━━━━━━━━━━━━━━━\n`;
      welcomeText += `💰 ${b("Deposit &amp; Play:")}\n`;
      welcomeText += `• Min bet: $0.02 USDT\n`;
      welcomeText += `• Min deposit: $1 USDT\n`;
      welcomeText += `• Withdrawals from $0.50\n\n`;
      welcomeText += `🎮 ${b("Games:")} Dice 🎲 | Slots 🎰 | Basketball 🏀\n`;
      welcomeText += `Bowling 🎳 | Darts 🎯 | Football ⚽ | RPS ✊\n\n`;
      welcomeText += `Use /referral to invite friends and earn 5% commission!`;
    } else {
      welcomeText = `🎰 ${b("Welcome back, " + name + "!")}\n\n`;
      welcomeText += `💵 ${b("Balance:")} ${formatUSD(parseFloat(String(dbUser.real_balance)))}\n`;
      if (parseFloat(String(dbUser.bonus_balance)) > 0) {
        welcomeText += `🎁 ${b("Bonus:")} ${formatUSD(parseFloat(String(dbUser.bonus_balance)))}\n`;
      }
      welcomeText += `\nChoose an option below:`;
    }

    await bot.sendMessage(chatId, welcomeText, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(),
    });
  } catch (err) {
    await bot.sendMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
}
