export function generateReferralCode(userId: number): string {
  return `REF${userId}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

export function formatUSD(amount: number): string {
  return `$${parseFloat(amount.toFixed(4))}`;
}

export function formatBalance(real: number, bonus: number): string {
  let text = `💵 Real: ${formatUSD(real)}`;
  if (bonus > 0) {
    text += `\n🎁 Bonus: ${formatUSD(bonus)}`;
  }
  return text;
}

export function calcHouseFee(amount: number, gameType: string, houseEdge: number): number {
  let feeRate: number;
  if (amount > 5) {
    feeRate = 0.08;
  } else {
    feeRate = 0.05 + ((houseEdge - 50) / 100);
  }
  return Math.round(amount * feeRate * 1e8) / 1e8;
}

export function calcWithdrawFee(amount: number): number {
  if (amount < 2) return amount * 0.15;
  if (amount <= 10) return amount * 0.10;
  return amount * 0.08;
}

export function getGameEmoji(gameType: string): string {
  const emojis: Record<string, string> = {
    dice: "🎲",
    slots: "🎰",
    basketball: "🏀",
    bowling: "🎳",
    darts: "🎯",
    football: "⚽",
    rps: "✊",
  };
  return emojis[gameType] || "🎮";
}

export function getRPSEmoji(choice: string): string {
  const emojis: Record<string, string> = {
    rock: "✊",
    paper: "📄",
    scissors: "✂️",
  };
  return emojis[choice] || choice;
}

export function rpsWinner(a: string, b: string): "a" | "b" | "draw" {
  if (a === b) return "draw";
  if (
    (a === "rock" && b === "scissors") ||
    (a === "scissors" && b === "paper") ||
    (a === "paper" && b === "rock")
  ) {
    return "a";
  }
  return "b";
}

export function parseBetAmount(text: string): number | null {
  const num = parseFloat(text);
  if (isNaN(num) || num <= 0) return null;
  return Math.round(num * 1e8) / 1e8;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncateName(name: string | null, maxLen = 20): string {
  if (!name) return "Anonymous";
  return name.length > maxLen ? name.substring(0, maxLen) + "..." : name;
}

export function formatDate(date: Date): string {
  return date.toISOString().replace("T", " ").substring(0, 19) + " UTC";
}

// Escape HTML special characters to prevent Telegram HTML parse errors
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Format a user display name safely for HTML mode
export function safeUserName(username?: string | null, firstName?: string | null, userId?: number): string {
  if (username) return escapeHtml(`@${username}`);
  if (firstName) return escapeHtml(firstName);
  return `User#${userId || "?"}`;
}

// Bold text (HTML)
export function b(text: string): string {
  return `<b>${text}</b>`;
}

// Italic text (HTML)
export function i(text: string): string {
  return `<i>${text}</i>`;
}

// Code text (HTML)
export function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}
