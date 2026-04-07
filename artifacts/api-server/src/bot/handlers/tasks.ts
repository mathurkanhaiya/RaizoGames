import TelegramBot from "node-telegram-bot-api";
import { query } from "../db";
import { adjustBalance } from "../services/userService";
import { formatUSD, b, i, code } from "../utils";

function progressBar(current: number, total: number, length = 10): string {
  const filled = Math.round((current / total) * length);
  const empty = length - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export async function handleTasks(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const tasks = await query(
    `SELECT t.*, 
      ut.progress, ut.completed, ut.reward_claimed
     FROM tasks t
     LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = $1
     WHERE t.is_active = TRUE
     ORDER BY t.task_type, t.target_value`,
    [userId]
  );

  if (tasks.rows.length === 0) {
    await bot.sendMessage(chatId, "📋 No active tasks right now. Check back later!");
    return;
  }

  const claimable = tasks.rows.filter(t => t.completed && !t.reward_claimed);
  const active = tasks.rows.filter(t => !t.completed);
  const done = tasks.rows.filter(t => t.completed && t.reward_claimed);

  let text = `📋 ${b("Tasks & Rewards")}\n\n`;

  // Claimable tasks (highlight at top)
  if (claimable.length > 0) {
    text += `🎁 ${b("Ready to Claim!")}\n`;
    for (const task of claimable) {
      text += `• ${b(task.name)} — ${formatUSD(parseFloat(task.reward))}\n`;
    }
    text += "\n";
  }

  // Active (in progress) tasks
  if (active.length > 0) {
    text += `⚡ ${b("In Progress")}\n`;
    for (const task of active) {
      const progress = task.progress || 0;
      const target = task.target_value;
      const pct = Math.min(100, Math.round((progress / target) * 100));
      const bar = progressBar(progress, target);

      text += `\n${getTaskIcon(task.task_type)} ${b(task.name)}\n`;
      text += `   ${task.description}\n`;
      text += `   ${bar} ${pct}%`;
      if (target > 1) text += ` (${progress}/${target})`;
      text += `\n   💰 Reward: ${formatUSD(parseFloat(task.reward))}\n`;
    }
  }

  // Completed tasks
  if (done.length > 0) {
    text += `\n✅ ${b("Completed")}: ${done.map(t => t.name).join(", ")}\n`;
  }

  // Build keyboard — claim buttons for claimable tasks + refresh
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  for (const task of claimable) {
    keyboard.push([{
      text: `🎁 Claim ${task.name} — ${formatUSD(parseFloat(task.reward))}`,
      callback_data: `claim_task_${task.id}`,
    }]);
  }
  keyboard.push([{ text: "🔄 Refresh", callback_data: "show_tasks" }]);

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

function getTaskIcon(taskType: string): string {
  switch (taskType) {
    case "make_deposit": return "💵";
    case "play_games": return "🎮";
    case "invite_friends": return "👥";
    case "wager_amount": return "🎰";
    default: return "🔲";
  }
}

export async function handleClaimTask(
  bot: TelegramBot,
  callbackQueryId: string,
  chatId: number,
  userId: number,
  taskId: number
): Promise<void> {
  const taskResult = await query(
    `SELECT ut.*, t.name, t.reward, t.task_type FROM user_tasks ut 
     JOIN tasks t ON t.id = ut.task_id
     WHERE ut.user_id=$1 AND ut.task_id=$2 AND ut.completed=TRUE AND ut.reward_claimed=FALSE`,
    [userId, taskId]
  );

  if (!taskResult.rows[0]) {
    try {
      await bot.answerCallbackQuery(callbackQueryId, { text: "Already claimed or not yet completed." });
    } catch { /* ignore */ }
    return;
  }

  const task = taskResult.rows[0];
  const reward = parseFloat(task.reward);

  await query(
    "UPDATE user_tasks SET reward_claimed=TRUE WHERE user_id=$1 AND task_id=$2",
    [userId, taskId]
  );

  await adjustBalance(userId, 0, reward, "bonus", `Task reward: ${task.name}`);

  try {
    await bot.answerCallbackQuery(callbackQueryId, { text: `🎉 +${formatUSD(reward)} claimed!` });
  } catch { /* ignore */ }

  await bot.sendMessage(chatId,
    `🎉 ${b("Task Reward Claimed!")}\n\n`
    + `${getTaskIcon(task.task_type)} ${b(task.name)}\n`
    + `💰 ${b("+" + formatUSD(reward))} added to your bonus balance!\n\n`
    + `${i("Bonus balance can be used for bets.")}`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "📋 View All Tasks", callback_data: "show_tasks" }]] },
    }
  );
}

export async function updateTaskProgress(
  userId: number,
  taskType: string,
  increment: number = 1,
  targetAmount?: number
): Promise<{ justCompleted: { name: string; reward: number }[] }> {
  const tasks = await query(
    "SELECT * FROM tasks WHERE task_type=$1 AND is_active=TRUE",
    [taskType]
  );

  const justCompleted: { name: string; reward: number }[] = [];

  // For wager_amount tasks, use cumulative total_wagered from bot_users
  let totalWagered: number | null = null;
  if (taskType === "wager_amount") {
    const uwRes = await query("SELECT total_wagered FROM bot_users WHERE id=$1", [userId]);
    totalWagered = parseFloat(uwRes.rows[0]?.total_wagered || "0");
  }

  for (const task of tasks.rows) {
    // Deposit tasks: check if deposited amount meets threshold
    if (taskType === "make_deposit" && targetAmount !== undefined && task.target_value > 1) {
      if (targetAmount < task.target_value) continue;
      increment = task.target_value;
    }

    const existing = await query(
      "SELECT * FROM user_tasks WHERE user_id=$1 AND task_id=$2",
      [userId, task.id]
    );

    if (existing.rows[0]?.completed) continue;

    let currentProgress: number;
    let completed: boolean;

    if (taskType === "wager_amount" && totalWagered !== null) {
      // Use actual cumulative wagered total
      currentProgress = Math.min(Math.floor(totalWagered), task.target_value);
      completed = totalWagered >= task.target_value;
    } else {
      currentProgress = (existing.rows[0]?.progress || 0) + increment;
      completed = currentProgress >= task.target_value;
    }

    if (existing.rows[0]) {
      await query(
        `UPDATE user_tasks SET progress=$1, completed=$2, 
          completed_at=CASE WHEN $2 THEN NOW() ELSE completed_at END 
         WHERE user_id=$3 AND task_id=$4`,
        [Math.min(currentProgress, task.target_value), completed, userId, task.id]
      );
    } else {
      await query(
        `INSERT INTO user_tasks (user_id, task_id, progress, completed, completed_at) 
         VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NOW() ELSE NULL END)`,
        [userId, task.id, Math.min(currentProgress, task.target_value), completed]
      );
    }

    if (completed) {
      justCompleted.push({ name: task.name, reward: parseFloat(task.reward) });
    }
  }

  return { justCompleted };
}
