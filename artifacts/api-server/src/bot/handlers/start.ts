import TelegramBot from "node-telegram-bot-api";
import { getOrCreateUser, giveNewbieBonus, getUserBalance } from "../services/userService";
import { formatUSD, escapeHtml, b, i, code } from "../utils";
import { mainMenuKeyboard } from "./keyboard";

const SUPPORT_LINK = "https://t.me/RaizoGamesSupport";
const CHANNEL_LINK = "https://t.me/raizologs";

export async function handleStart(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const user = msg.from;
  if (!user) return;

  const text = msg.text || "";
  const parts = text.split(" ");
  // Accept referral code ONLY — the accept_X deep link is handled in bot.ts before here
  const referralCode = parts.length > 1 && !parts[1].startsWith("accept_") ? parts[1] : undefined;

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
    const balance = await getUserBalance(user.id);

    let welcomeText = "";

    if (isNew) {
      const bonus = await giveNewbieBonus(user.id);
      welcomeText =
        `🎰 ${b("Welcome to RAIZO GAMES, " + name + "!")}\n`
        + `🔥 ${b("The #1 PvP Casino Bot on Telegram")}\n\n`

        + (bonus > 0
          ? `🎁 ${b("Newbie Bonus:")} ${formatUSD(bonus)} credited!\n`
          + `${i("Expires in 7 days · 7x wager to withdraw")}\n\n`
          : "")

        + `━━━━━━━━━━━━━━━━━━━\n`
        + `🎮 ${b("7 Games Available:")}\n`
        + `🎲 Dice  🎰 Slots  ✊ RPS\n`
        + `🏀 Basketball  🎳 Bowling\n`
        + `🎯 Darts  ⚽ Football\n\n`

        + `⚔️ ${b("Two Modes:")}\n`
        + `• ${b("PvP")} — Challenge real players in groups\n`
        + `• ${b("vs Bot")} — Instant play, any time\n\n`

        + `💰 ${b("Deposits:")}\n`
        + `• USDT (auto, instant) · Min $0.05\n`
        + `• ⭐ Stars (21-day lock) · Min 5 Stars\n`
        + `• TON (manual, with memo)\n\n`

        + `💸 ${b("Withdrawals:")} Min $0.50 · Auto-processed\n`
        + `👥 ${b("Referrals:")} Earn 5% on every friend's first deposit\n\n`

        + `📋 /help — Full command list\n`
        + `💬 Support: ${SUPPORT_LINK}`;

    } else {
      const bonus = parseFloat(String(dbUser.bonus_balance));
      welcomeText =
        `🎰 ${b("Welcome back, " + name + "!")}\n\n`
        + `💵 ${b("Real Balance:")} ${formatUSD(balance.real)}\n`
        + (bonus > 0 ? `🎁 ${b("Bonus:")} ${formatUSD(bonus)}\n` : "")
        + `\nWhat would you like to do?`;
    }

    await bot.sendMessage(chatId, welcomeText, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: mainMenuKeyboard(),
    });
  } catch (err) {
    await bot.sendMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
}

export async function handleHelp(bot: TelegramBot, chatId: number): Promise<void> {
  const text =
    `📋 ${b("RAIZO GAMES — Command Guide")}\n\n`

    + `${b("🎮 Gaming")}\n`
    + `• /play — Choose mode &amp; game to bet\n`
    + `• /bet &lt;game&gt; &lt;amount&gt; — Quick bet\n`
    + `  e.g. ${code("/bet dice 0.10")}\n`
    + `• /join — Browse open PvP bets to accept\n\n`

    + `${b("💰 Wallet")}\n`
    + `• /balance — View balances &amp; full stats\n`
    + `• /deposit — Fund with USDT · Stars · TON\n`
    + `• /withdraw — Request USDT payout\n\n`

    + `${b("📊 Social")}\n`
    + `• /leaderboard — Top players by volume\n`
    + `• /referral — Your referral link (5% commissions)\n`
    + `• /tasks — Daily tasks &amp; bonus rewards\n`
    + `• /stats — Your personal game stats\n\n`

    + `${b("⭐ Stars Info")}\n`
    + `• 1 Star = $0.01 USD\n`
    + `• 21-day lock applies (Telegram policy)\n`
    + `• Check lock status: /balance → Pending Stars\n\n`

    + `${b("🏆 How to Win")}\n`
    + `• Dice/Bowling: higher roll wins\n`
    + `• Slots: 3-of-a-kind pays big\n`
    + `• Basketball/Football/Darts: score = value\n`
    + `• RPS: classic rules\n\n`

    + `${b("💬 Support")}\n`
    + `• Chat: ${SUPPORT_LINK}\n`
    + `• Channel/Logs: ${CHANNEL_LINK}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎮 Play Now", callback_data: "back_main" }],
        [{ text: "💬 Support Chat", url: SUPPORT_LINK }],
      ],
    },
  });
}
