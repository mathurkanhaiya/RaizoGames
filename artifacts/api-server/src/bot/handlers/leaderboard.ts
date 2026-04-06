import TelegramBot from "node-telegram-bot-api";
import { getLeaderboard, getUserStats } from "../services/userService";
import { formatUSD, truncateName } from "../utils";

export async function handleLeaderboard(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const top = await getLeaderboard(10);

  let text = `🏆 *RAIZO GAMES Leaderboard*\n\n`;
  text += `_Top players by total wagered (resets daily)_\n\n`;

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

  for (let i = 0; i < top.length; i++) {
    const player = top[i];
    const name = truncateName(player.username ? `@${player.username}` : player.first_name);
    const wagered = parseFloat(String(player.total_wagered));
    const isYou = player.id === userId;
    text += `${medals[i] || `${i+1}.`} ${name}${isYou ? " _(you)_" : ""}\n`;
    text += `   Wagered: ${formatUSD(wagered)}\n\n`;
  }

  if (top.length === 0) {
    text += `No players yet. Be the first to play!\n`;
  }

  const userStats = await getUserStats(userId);
  text += `━━━━━━━━━━━━━━━━━━━\n`;
  text += `📊 *Your Stats:*\n`;
  text += `• Games played: ${userStats?.total_games || 0}\n`;
  text += `• Wins: ${userStats?.wins || 0}\n`;
  text += `• Total winnings: ${formatUSD(parseFloat(userStats?.total_winnings || "0"))}\n`;

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}
