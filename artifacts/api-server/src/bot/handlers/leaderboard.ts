import TelegramBot from "node-telegram-bot-api";
import { getLeaderboard, getUserStats } from "../services/userService";
import { formatUSD, safeUserName, b, i } from "../utils";

export async function handleLeaderboard(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const top = await getLeaderboard(10);

  let text = `🏆 ${b("RAIZO GAMES Leaderboard")}\n\n`;
  text += `${i("Top players by total wagered")}\n\n`;

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

  for (let i2 = 0; i2 < top.length; i2++) {
    const player = top[i2];
    const name = safeUserName(player.username, player.first_name, player.id);
    const wagered = parseFloat(String(player.total_wagered));
    const isYou = Number(player.id) === userId;
    text += `${medals[i2] || `${i2 + 1}.`} ${name}${isYou ? " (you)" : ""}\n`;
    text += `   Wagered: ${formatUSD(wagered)}\n\n`;
  }

  if (top.length === 0) {
    text += `No players yet. Be the first to play!\n`;
  }

  const userStats = await getUserStats(userId);
  text += `━━━━━━━━━━━━━━━━━━━\n`;
  text += `📊 ${b("Your Stats:")}\n`;
  text += `• Games played: ${userStats?.total_games || 0}\n`;
  text += `• Wins: ${userStats?.wins || 0}\n`;
  text += `• Total winnings: ${formatUSD(parseFloat(userStats?.total_winnings || "0"))}\n`;

  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}
