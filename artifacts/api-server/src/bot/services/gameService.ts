import { query } from "../db";
import { calcHouseFee } from "../utils";
import { getHouseEdge, recordPayout, recordWager } from "./riskService";
import { addWagered, adjustBalance, updateStreak } from "./userService";

export interface GameBet {
  id: number;
  creator_id: number;
  opponent_id: number | null;
  game_type: string;
  mode: string;
  bet_amount: number;
  status: string;
  winner_id: number | null;
  creator_result: string | null;
  opponent_result: string | null;
  creator_choice: string | null;
  opponent_choice: string | null;
  house_fee: number;
  payout: number;
  group_chat_id: number | null;
  message_id: number | null;
  expires_at: Date;
  created_at: Date;
  completed_at: Date | null;
}

export async function createBet(
  creatorId: number,
  gameType: string,
  mode: "pvp" | "bot",
  betAmount: number,
  groupChatId?: number,
  messageId?: number
): Promise<GameBet> {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min expiry

  const result = await query(
    `INSERT INTO game_bets (creator_id, game_type, mode, bet_amount, group_chat_id, message_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [creatorId, gameType, mode, betAmount, groupChatId || null, messageId || null, expiresAt]
  );

  // Deduct bet from creator balance immediately
  await adjustBalance(
    creatorId,
    -betAmount,
    0,
    "bet",
    `Placed ${gameType} bet #${result.rows[0].id}`,
    String(result.rows[0].id)
  );

  return result.rows[0];
}

export async function acceptBet(betId: number, opponentId: number): Promise<GameBet | null> {
  const betResult = await query(
    "SELECT * FROM game_bets WHERE id = $1 AND status = 'waiting'",
    [betId]
  );

  if (!betResult.rows[0]) return null;
  const bet = betResult.rows[0];

  if (bet.creator_id === opponentId) return null; // Can't accept own bet

  // Check opponent has enough balance
  const opponentRes = await query(
    "SELECT real_balance, bonus_balance FROM bot_users WHERE id=$1",
    [opponentId]
  );
  const opponentBalance =
    parseFloat(opponentRes.rows[0]?.real_balance || "0") +
    parseFloat(opponentRes.rows[0]?.bonus_balance || "0");

  if (opponentBalance < parseFloat(bet.bet_amount)) {
    return null; // insufficient funds
  }

  // Deduct from opponent
  await adjustBalance(
    opponentId,
    -parseFloat(bet.bet_amount),
    0,
    "bet",
    `Accepted ${bet.game_type} bet #${betId}`,
    String(betId)
  );

  const updated = await query(
    `UPDATE game_bets SET opponent_id=$1, status='active', updated_at=NOW() WHERE id=$2 RETURNING *`,
    [opponentId, betId]
  );

  return updated.rows[0];
}

export async function completeBet(
  betId: number,
  creatorResult: string,
  opponentResult: string,
  // winnerId: positive = real user won, null = draw, negative = bot won (house wins)
  winnerId: number | null,
  creatorChoice?: string,
  opponentChoice?: string
): Promise<GameBet> {
  const betResult = await query("SELECT * FROM game_bets WHERE id = $1", [betId]);
  const bet = betResult.rows[0];
  if (!bet) throw new Error(`Bet #${betId} not found`);

  const betAmount = parseFloat(bet.bet_amount);
  const houseEdge = await getHouseEdge(bet.game_type);
  const houseFee = calcHouseFee(betAmount, bet.game_type, houseEdge);
  const totalPot = betAmount * 2;
  const payout = totalPot - houseFee;

  // Store NULL in DB when bot wins (winnerId < 0) — house wins, no real user is the winner
  const dbWinnerId = winnerId !== null && winnerId > 0 ? winnerId : null;
  // But we still need to know if it was a draw (null) vs bot-win (negative)
  const isBotWin = winnerId !== null && winnerId < 0;
  const isDraw = winnerId === null;

  // payout = actual amount paid out to the winner
  // house_fee = what the house earned from this game
  // For bot wins: house earned the full betAmount (creator's stake), payout = 0
  // For user wins: house earned houseFee, payout = totalPot - houseFee
  // For draw: house earned 0, payout = 0 (both refunded)
  const dbPayout = isDraw ? 0 : isBotWin ? 0 : payout;
  const dbHouseFee = isDraw ? 0 : isBotWin ? betAmount : houseFee;

  const updated = await query(
    `UPDATE game_bets SET 
      status='completed',
      winner_id=$1,
      creator_result=$2,
      opponent_result=$3,
      creator_choice=$4,
      opponent_choice=$5,
      house_fee=$6,
      payout=$7,
      completed_at=NOW()
     WHERE id=$8 RETURNING *`,
    [
      dbWinnerId,
      creatorResult,
      opponentResult,
      creatorChoice || null,
      opponentChoice || null,
      dbHouseFee,
      dbPayout,
      betId,
    ]
  );

  // Record total wager in house stats
  await recordWager(bet.mode === "bot" ? betAmount : totalPot);

  if (isDraw) {
    // Draw: refund both players
    await adjustBalance(
      bet.creator_id,
      betAmount,
      0,
      "refund",
      `Draw in ${bet.game_type} bet #${betId} — refund`,
      String(betId)
    );
    if (bet.opponent_id) {
      await adjustBalance(
        bet.opponent_id,
        betAmount,
        0,
        "refund",
        `Draw in ${bet.game_type} bet #${betId} — refund`,
        String(betId)
      );
    }
  } else if (isBotWin) {
    // Bot wins → house keeps creator's bet (already deducted from creator)
    // No payout needed. Record house profit.
    await recordPayout(0); // bot kept the money
    // Creator is the loser — update their loss streak
    await updateStreak(bet.creator_id, false);
  } else {
    // Real user wins
    const realWinnerId = dbWinnerId!;
    await adjustBalance(
      realWinnerId,
      payout,
      0,
      "win",
      `Won ${bet.game_type} bet #${betId}`,
      String(betId)
    );
    await recordPayout(payout);
    await updateStreak(realWinnerId, true);

    // Update loser streak
    const loserId =
      realWinnerId === bet.creator_id ? bet.opponent_id : bet.creator_id;
    if (loserId && loserId > 0) {
      await updateStreak(loserId, false);
    }

    // Pay referral commission on win (only for real user wins)
    await payReferralCommission(realWinnerId, betAmount);
  }

  // Track wager totals for both real players
  await addWagered(bet.creator_id, betAmount);
  if (bet.opponent_id && bet.opponent_id > 0) {
    await addWagered(bet.opponent_id, betAmount);
  }

  return updated.rows[0];
}

async function payReferralCommission(userId: number, betAmount: number): Promise<void> {
  if (!userId || userId <= 0) return;

  const userResult = await query(
    "SELECT referral_id FROM bot_users WHERE id=$1",
    [userId]
  );
  const referrerId = userResult.rows[0]?.referral_id;
  if (!referrerId || referrerId <= 0) return;

  const commission = betAmount * 0.005; // 0.5% commission on wins (not 5% - that's on deposits)
  if (commission < 0.0001) return; // too small to bother

  await adjustBalance(
    referrerId,
    commission,
    0,
    "referral",
    `Referral commission from user ${userId} game win`
  );
  await query(
    `INSERT INTO referral_earnings (referrer_id, referee_id, tier, amount, source_type)
     VALUES ($1, $2, 1, $3, 'wager')`,
    [referrerId, userId, commission]
  );
}

export async function cancelBet(betId: number): Promise<void> {
  const betResult = await query(
    "SELECT * FROM game_bets WHERE id=$1 AND status IN ('waiting', 'active')",
    [betId]
  );
  const bet = betResult.rows[0];
  if (!bet) return;

  // Mark as cancelled FIRST to prevent double-processing
  await query(
    "UPDATE game_bets SET status='cancelled', updated_at=NOW() WHERE id=$1",
    [betId]
  );

  // Refund creator
  await adjustBalance(
    bet.creator_id,
    parseFloat(bet.bet_amount),
    0,
    "refund",
    `Cancelled bet #${betId}`
  );

  // Refund opponent if they joined
  if (bet.opponent_id && bet.opponent_id > 0) {
    await adjustBalance(
      bet.opponent_id,
      parseFloat(bet.bet_amount),
      0,
      "refund",
      `Cancelled bet #${betId}`
    );
  }
}

export async function getWaitingBets(gameType?: string, groupChatId?: number): Promise<GameBet[]> {
  let sql = `SELECT gb.*, u.username, u.first_name 
             FROM game_bets gb 
             JOIN bot_users u ON gb.creator_id = u.id
             WHERE gb.status = 'waiting' AND gb.expires_at > NOW()`;
  const params: unknown[] = [];

  if (gameType) {
    params.push(gameType);
    sql += ` AND gb.game_type = $${params.length}`;
  }
  if (groupChatId) {
    params.push(groupChatId);
    sql += ` AND gb.group_chat_id = $${params.length}`;
  }

  sql += " ORDER BY gb.created_at DESC LIMIT 10";
  const result = await query(sql, params);
  return result.rows;
}

export async function getUserBetHistory(userId: number, limit = 10): Promise<GameBet[]> {
  const result = await query(
    `SELECT * FROM game_bets 
     WHERE (creator_id=$1 OR opponent_id=$1) AND status='completed'
     ORDER BY completed_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

export async function expireOldBets(): Promise<void> {
  // Fetch and expire in one step — cancel refunds and mark expired atomically
  const expired = await query(
    "SELECT * FROM game_bets WHERE status='waiting' AND expires_at < NOW()"
  );

  for (const bet of expired.rows) {
    // First refund (cancelBet sets status to 'cancelled')
    await cancelBet(bet.id);
    // Then override status to 'expired' to distinguish from user-cancelled bets
    await query(
      "UPDATE game_bets SET status='expired' WHERE id=$1 AND status='cancelled'",
      [bet.id]
    );
  }
}
