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

  // Deduct bet from creator balance
  await adjustBalance(creatorId, -betAmount, 0, "bet", `Placed ${gameType} bet #${result.rows[0].id}`, String(result.rows[0].id));

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

  // Deduct from opponent
  await adjustBalance(opponentId, -bet.bet_amount, 0, "bet", `Accepted ${bet.game_type} bet #${betId}`, String(betId));

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
  winnerId: number | null,
  creatorChoice?: string,
  opponentChoice?: string
): Promise<GameBet> {
  const betResult = await query("SELECT * FROM game_bets WHERE id = $1", [betId]);
  const bet = betResult.rows[0];

  const houseEdge = await getHouseEdge(bet.game_type);
  const houseFee = calcHouseFee(parseFloat(bet.bet_amount), bet.game_type, houseEdge);
  const totalPot = parseFloat(bet.bet_amount) * 2;
  const payout = totalPot - houseFee;

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
    [winnerId, creatorResult, opponentResult, creatorChoice || null, opponentChoice || null, houseFee, payout, betId]
  );

  // Record house stats
  await recordWager(totalPot);

  if (winnerId) {
    // Pay winner
    await adjustBalance(winnerId, payout, 0, "win", `Won ${bet.game_type} bet #${betId}`, String(betId));
    await recordPayout(payout);
    await updateStreak(winnerId, true);

    // Update loser streak
    const loserId = winnerId === bet.creator_id ? bet.opponent_id : bet.creator_id;
    if (loserId) {
      await updateStreak(loserId, false);
    }
  } else {
    // Draw - refund both
    await adjustBalance(bet.creator_id, parseFloat(bet.bet_amount), 0, "win", `Draw in ${bet.game_type} bet #${betId} (refund)`, String(betId));
    if (bet.opponent_id) {
      await adjustBalance(bet.opponent_id, parseFloat(bet.bet_amount), 0, "win", `Draw in ${bet.game_type} bet #${betId} (refund)`, String(betId));
    }
  }

  // Update wager stats
  await addWagered(bet.creator_id, parseFloat(bet.bet_amount));
  if (bet.opponent_id) {
    await addWagered(bet.opponent_id, parseFloat(bet.bet_amount));
  }

  // Check referral commission
  if (winnerId) {
    await payReferralCommission(winnerId, parseFloat(bet.bet_amount));
  }

  return updated.rows[0];
}

async function payReferralCommission(userId: number, betAmount: number): Promise<void> {
  const userResult = await query(
    "SELECT referral_id FROM bot_users WHERE id=$1",
    [userId]
  );
  const referrerId = userResult.rows[0]?.referral_id;
  if (!referrerId) return;

  const commission = betAmount * 0.05; // 5% tier 1
  await adjustBalance(referrerId, commission, 0, "referral", `Referral commission from user ${userId}`);
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

  // Refund creator
  await adjustBalance(bet.creator_id, parseFloat(bet.bet_amount), 0, "refund", `Cancelled bet #${betId}`);

  // Refund opponent if accepted
  if (bet.opponent_id) {
    await adjustBalance(bet.opponent_id, parseFloat(bet.bet_amount), 0, "refund", `Cancelled bet #${betId}`);
  }

  await query("UPDATE game_bets SET status='cancelled' WHERE id=$1", [betId]);
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
  const expired = await query(
    "SELECT * FROM game_bets WHERE status='waiting' AND expires_at < NOW()"
  );

  for (const bet of expired.rows) {
    await cancelBet(bet.id);
    await query("UPDATE game_bets SET status='expired' WHERE id=$1", [bet.id]);
  }
}
