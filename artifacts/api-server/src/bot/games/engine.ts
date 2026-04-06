import { rpsWinner } from "../utils";

export interface GameResult {
  value: string | number;
  display: string;
  emoji: string;
  telegramDiceEmoji?: string;
}

export interface GameOutcome {
  creatorResult: GameResult;
  opponentResult: GameResult;
  winner: "creator" | "opponent" | "draw";
  summary: string;
}

// Telegram dice value ranges:
// 🎲 dice: 1-6
// 🎰 slots: 1-64 (jackpot=64)
// 🏀 basketball: 1-5 (4-5 = basket)
// 🎳 bowling: 1-6 (6 = strike)
// 🎯 darts: 1-6 (6 = bullseye)
// ⚽ football: 1-5 (3-5 = goal)

export function telegramDiceEmoji(gameType: string): string {
  const map: Record<string, string> = {
    dice: "🎲",
    slots: "🎰",
    basketball: "🏀",
    bowling: "🎳",
    darts: "🎯",
    football: "⚽",
  };
  return map[gameType] || "🎲";
}

export function isDiceWin(gameType: string, value: number): boolean {
  switch (gameType) {
    case "dice": return value >= 4;
    case "slots": return value === 64;
    case "basketball": return value >= 4;
    case "bowling": return value === 6;
    case "darts": return value >= 5;
    case "football": return value >= 3;
    default: return false;
  }
}

export function getDiceScore(gameType: string, value: number): number {
  // Returns normalized score for comparison
  return value;
}

export function resolveGameByValues(
  gameType: string,
  creatorValue: number,
  opponentValue: number,
  creatorChoice?: string,
  opponentChoice?: string
): "creator" | "opponent" | "draw" {
  if (gameType === "rps") {
    const result = rpsWinner(creatorChoice || "rock", opponentChoice || "rock");
    if (result === "a") return "creator";
    if (result === "b") return "opponent";
    return "draw";
  }

  if (creatorValue > opponentValue) return "creator";
  if (opponentValue > creatorValue) return "opponent";
  return "draw";
}

export function generateBotDiceValue(gameType: string, botShouldLose: boolean, playerValue: number): number {
  if (gameType === "rps") return 0; // handled separately

  let botValue: number;
  const max = getDiceMax(gameType);

  if (botShouldLose) {
    // Bot should lose - pick value lower than player
    if (playerValue > 1) {
      botValue = Math.floor(Math.random() * (playerValue - 1)) + 1;
    } else {
      botValue = 1; // draw at worst
    }
  } else {
    // Bot should win - pick value higher or equal (house edge)
    botValue = Math.floor(Math.random() * (max - playerValue)) + playerValue;
    if (botValue > max) botValue = max;
  }

  return botValue;
}

function getDiceMax(gameType: string): number {
  const maxes: Record<string, number> = {
    dice: 6,
    slots: 64,
    basketball: 5,
    bowling: 6,
    darts: 6,
    football: 5,
  };
  return maxes[gameType] || 6;
}

export function formatDiceResult(gameType: string, value: number): string {
  switch (gameType) {
    case "dice": return `Rolled ${value}`;
    case "slots": return value === 64 ? "JACKPOT! 777" : `Rolled ${value}`;
    case "basketball": return value >= 4 ? "BASKET!" : `Missed (${value})`;
    case "bowling": return value === 6 ? "STRIKE!" : `${value} pins`;
    case "darts": return value === 6 ? "BULLSEYE!" : `${value} pts`;
    case "football": return value >= 3 ? "GOAL!" : `Missed (${value})`;
    default: return String(value);
  }
}

export function getRPSBotChoice(playerChoice: string, botShouldLose: boolean): string {
  const choices = ["rock", "paper", "scissors"];
  if (botShouldLose) {
    // Return losing choice
    const losingMap: Record<string, string> = {
      rock: "scissors",
      scissors: "paper",
      paper: "rock",
    };
    return losingMap[playerChoice] || choices[Math.floor(Math.random() * 3)];
  } else {
    // Return winning choice
    const winningMap: Record<string, string> = {
      rock: "paper",
      scissors: "rock",
      paper: "scissors",
    };
    return winningMap[playerChoice] || choices[Math.floor(Math.random() * 3)];
  }
}
