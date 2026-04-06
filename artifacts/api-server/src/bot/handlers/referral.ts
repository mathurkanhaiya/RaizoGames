import TelegramBot from "node-telegram-bot-api";
import { getUser } from "../services/userService";
import { query } from "../db";
import { formatUSD } from "../utils";

export async function handleReferral(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;

  const botUsername = process.env.BOT_USERNAME || "RaizoPvPBot";

  // Count referrals
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

  const text = `👥 *Refer & Earn*\n\n`
    + `Invite friends and earn commissions:\n`
    + `• Tier 1: *5%* of referee's first deposit\n`
    + `• Tier 2 (VIP): *10%* commission\n\n`
    + `🛡 Commission requires real deposit from referee\n\n`
    + `━━━━━━━━━━━━━━━━━━━\n`
    + `📊 *Your Stats:*\n`
    + `• Referrals: ${totalReferrals}\n`
    + `• Total Earned: ${formatUSD(totalEarned)}\n\n`
    + `🔗 *Your Referral Link:*\n`
    + `\`${referralLink}\`\n\n`
    + `Share this link — when someone signs up and deposits, you earn!`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📤 Share Invite Link", url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join RAIZO GAMES - Fast PvP Casino Bot! 🎰")}` }],
      ],
    },
  });
}
