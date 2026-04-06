import TelegramBot from "node-telegram-bot-api";

export function mainMenuKeyboard(): TelegramBot.ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: "🎮 Play" }, { text: "💰 Wallet" }],
      [{ text: "🏆 Leaderboard" }, { text: "👥 Refer & Earn" }],
      [{ text: "📋 Tasks" }, { text: "📊 My Stats" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

export function gameSelectKeyboard(mode: "pvp" | "bot"): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🎲 Dice", callback_data: `game_${mode}_dice` },
        { text: "🎰 Slots", callback_data: `game_${mode}_slots` },
        { text: "✊ RPS", callback_data: `game_${mode}_rps` },
      ],
      [
        { text: "🏀 Basketball", callback_data: `game_${mode}_basketball` },
        { text: "🎳 Bowling", callback_data: `game_${mode}_bowling` },
      ],
      [
        { text: "🎯 Darts", callback_data: `game_${mode}_darts` },
        { text: "⚽ Football", callback_data: `game_${mode}_football` },
      ],
      [{ text: "« Back", callback_data: "back_main" }],
    ],
  };
}

export function modeSelectKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "⚔️ PvP (Group)", callback_data: "mode_pvp" },
        { text: "🤖 vs Bot", callback_data: "mode_bot" },
      ],
      [{ text: "« Back", callback_data: "back_main" }],
    ],
  };
}

export function betAmountKeyboard(gameType: string, mode: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "$0.05", callback_data: `bet_${mode}_${gameType}_0.05` },
        { text: "$0.10", callback_data: `bet_${mode}_${gameType}_0.10` },
        { text: "$0.25", callback_data: `bet_${mode}_${gameType}_0.25` },
      ],
      [
        { text: "$0.50", callback_data: `bet_${mode}_${gameType}_0.50` },
        { text: "$1.00", callback_data: `bet_${mode}_${gameType}_1.00` },
        { text: "$5.00", callback_data: `bet_${mode}_${gameType}_5.00` },
      ],
      [
        { text: "$10.00", callback_data: `bet_${mode}_${gameType}_10.00` },
        { text: "✏️ Custom", callback_data: `bet_${mode}_${gameType}_custom` },
      ],
      [{ text: "« Back", callback_data: `game_${mode}_back` }],
    ],
  };
}

export function depositKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "💵 USDT (Auto)", callback_data: "deposit_usdt" }],
      [{ text: "⭐ Telegram Stars", callback_data: "deposit_stars" }],
      [{ text: "⚡ TON Manual", callback_data: "deposit_ton" }],
      [{ text: "« Back", callback_data: "back_wallet" }],
    ],
  };
}

export function withdrawKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "💸 Withdraw USDT", callback_data: "withdraw_usdt" }],
      [{ text: "📋 Withdrawal History", callback_data: "withdraw_history" }],
      [{ text: "« Back", callback_data: "back_wallet" }],
    ],
  };
}

export function walletKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "📥 Deposit", callback_data: "wallet_deposit" },
        { text: "📤 Withdraw", callback_data: "wallet_withdraw" },
      ],
      [
        { text: "📋 Transactions", callback_data: "wallet_transactions" },
        { text: "⭐ Pending Stars", callback_data: "wallet_pending_stars" },
      ],
    ],
  };
}

export function rpsKeyboard(betId: number, isCreator: boolean): TelegramBot.InlineKeyboardMarkup {
  const prefix = isCreator ? `rps_creator_${betId}` : `rps_opponent_${betId}`;
  return {
    inline_keyboard: [
      [
        { text: "✊ Rock", callback_data: `${prefix}_rock` },
        { text: "📄 Paper", callback_data: `${prefix}_paper` },
        { text: "✂️ Scissors", callback_data: `${prefix}_scissors` },
      ],
    ],
  };
}

export function acceptBetKeyboard(betId: number): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Accept Bet", callback_data: `accept_bet_${betId}` },
        { text: "❌ Cancel", callback_data: `cancel_bet_${betId}` },
      ],
    ],
  };
}

export function adminWithdrawKeyboard(withdrawId: number): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `admin_approve_${withdrawId}` },
        { text: "❌ Reject", callback_data: `admin_reject_${withdrawId}` },
      ],
    ],
  };
}
