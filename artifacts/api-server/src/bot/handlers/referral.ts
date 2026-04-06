import TelegramBot from "node-telegram-bot-api";
import { getUser } from "../services/userService";
import { query } from "../db";
import { formatUSD, escapeHtml, b, i } from "../utils";

export async function handleReferral(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;

  const botUsername = process.env.BOT_USERNAME || "RaizoPvPBot";

  const stats = await query(
    `SELECT 
      COUNT(*) as total_referrals,
      SUM(re.amount) as total_earned
     FROM referral_earnings re
     WHERE re.referrer_id = $1`,
    [userId]
  );

  const referralLink = `https://t.me/${botUsername}?start=${user.referral_code}`;
  const totalReferrals = parseInt(stats.rows[0]?.total_referrals || "0");
  const totalEarned = parseFloat(stats.rows[0]?.total_earned || "0");

  const text = `👥 ${b("Refer &amp; Earn")}\n\n`
    + `Invite friends and earn commissions:\n`
    + `• Tier 1: ${b("5%")} of referee's first deposit\n`
    + `• Tier 2 (VIP): ${b("10%")} commission\n\n`
    + `🛡 Commission requires real deposit from referee\n\n`
    + `━━━━━━━━━━━━━━━━━━━\n`
    + `📊 ${b("Your Stats:")}\n`
    + `• Referrals: ${totalReferrals}\n`
    + `• Total Earned: ${formatUSD(totalEarned)}\n\n`
    + `🔗 ${b("Your Referral Link:")}\n`
    + `${escapeHtml(referralLink)}\n\n`
    + `Share this link — when someone signs up and deposits, you earn!`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{
          text: "📤 Share Invite Link",
          url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join RAIZO GAMES - Fast PvP Casino Bot! 🎰")}`,
        }],
      ],
    },
  });
}
