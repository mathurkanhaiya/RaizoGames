import TelegramBot from "node-telegram-bot-api";
import { query } from "../db";
import { adjustBalance } from "../services/userService";
import { formatUSD } from "../utils";

export async function handleTasks(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const tasks = await query(
    `SELECT t.*, 
      ut.progress, ut.completed, ut.reward_claimed
     FROM tasks t
     LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = $1
     WHERE t.is_active = TRUE
     ORDER BY t.reward DESC`,
    [userId]
  );

  if (tasks.rows.length === 0) {
    await bot.sendMessage(chatId, "📋 No active tasks right now. Check back later!");
    return;
  }

  let text = `📋 *Tasks & Rewards*\n\n`;
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

  for (const task of tasks.rows) {
    const isCompleted = task.completed;
    const isClaimed = task.reward_claimed;
    const progress = task.progress || 0;
    const icon = isClaimed ? "✅" : isCompleted ? "🎁" : "🔲";

    text += `${icon} *${task.name}*\n`;
    text += `   ${task.description}\n`;
    text += `   Reward: ${formatUSD(parseFloat(task.reward))}\n`;
    if (task.target_value > 1) {
      text += `   Progress: ${progress}/${task.target_value}\n`;
    }
    text += "\n";

    if (isCompleted && !isClaimed) {
      keyboard.push([{
        text: `🎁 Claim: ${task.name} (${formatUSD(parseFloat(task.reward))})`,
        callback_data: `claim_task_${task.id}`,
      }]);
    }
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
  });
}

export async function handleClaimTask(bot: TelegramBot, chatId: number, userId: number, taskId: number): Promise<void> {
  const taskResult = await query(
    `SELECT ut.*, t.name, t.reward FROM user_tasks ut 
     JOIN tasks t ON t.id = ut.task_id
     WHERE ut.user_id=$1 AND ut.task_id=$2 AND ut.completed=TRUE AND ut.reward_claimed=FALSE`,
    [userId, taskId]
  );

  if (!taskResult.rows[0]) {
    await bot.answerCallbackQuery("", { text: "Task not available or already claimed." });
    return;
  }

  const task = taskResult.rows[0];
  const reward = parseFloat(task.reward);

  await query(
    "UPDATE user_tasks SET reward_claimed=TRUE WHERE user_id=$1 AND task_id=$2",
    [userId, taskId]
  );

  await adjustBalance(userId, reward, 0, "bonus", `Task reward: ${task.name}`);

  await bot.sendMessage(chatId,
    `🎉 *Task Completed!*\n\n${task.name}\nReward: *${formatUSD(reward)}* added to your balance!`,
    { parse_mode: "Markdown" }
  );
}

export async function updateTaskProgress(userId: number, taskType: string, increment: number = 1): Promise<void> {
  const tasks = await query(
    "SELECT * FROM tasks WHERE task_type=$1 AND is_active=TRUE",
    [taskType]
  );

  for (const task of tasks.rows) {
    const existing = await query(
      "SELECT * FROM user_tasks WHERE user_id=$1 AND task_id=$2",
      [userId, task.id]
    );

    if (existing.rows[0]?.completed) continue;

    const currentProgress = (existing.rows[0]?.progress || 0) + increment;
    const completed = currentProgress >= task.target_value;

    if (existing.rows[0]) {
      await query(
        "UPDATE user_tasks SET progress=$1, completed=$2, completed_at=CASE WHEN $2 THEN NOW() ELSE completed_at END WHERE user_id=$3 AND task_id=$4",
        [Math.min(currentProgress, task.target_value), completed, userId, task.id]
      );
    } else {
      await query(
        "INSERT INTO user_tasks (user_id, task_id, progress, completed, completed_at) VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NOW() ELSE NULL END)",
        [userId, task.id, Math.min(currentProgress, task.target_value), completed]
      );
    }
  }
}
