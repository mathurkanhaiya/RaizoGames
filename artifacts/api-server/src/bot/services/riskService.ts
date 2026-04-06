import { query } from "../db";

let settingsCache: Record<string, string> = {};
let cacheTime = 0;

export async function getSettings(): Promise<Record<string, string>> {
  if (Date.now() - cacheTime < 30000) return settingsCache;
  const result = await query("SELECT key, value FROM risk_settings");
  settingsCache = {};
  for (const row of result.rows) {
    settingsCache[row.key] = row.value;
  }
  cacheTime = Date.now();
  return settingsCache;
}

export async function getSetting(key: string, defaultVal: string = "0"): Promise<string> {
  const settings = await getSettings();
  return settings[key] ?? defaultVal;
}

export async function getSettingNum(key: string, defaultVal: number = 0): Promise<number> {
  const val = await getSetting(key, String(defaultVal));
  return parseFloat(val) || defaultVal;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO risk_settings (key, value) VALUES ($1, $2) 
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
    [key, value]
  );
  settingsCache = {}; // invalidate cache
}

export async function getDailyPayout(): Promise<number> {
  const result = await query(
    "SELECT total_paid_out FROM house_stats WHERE date = CURRENT_DATE"
  );
  return parseFloat(result.rows[0]?.total_paid_out || "0");
}

export async function getMaxDailyPayout(): Promise<number> {
  return getSettingNum("max_daily_payout", 500);
}

export async function recordPayout(amount: number): Promise<void> {
  await query(
    `INSERT INTO house_stats (date, total_paid_out, ggr)
     VALUES (CURRENT_DATE, $1, -$1)
     ON CONFLICT (date) DO UPDATE SET 
       total_paid_out = house_stats.total_paid_out + $1,
       ggr = house_stats.ggr - $1,
       updated_at = NOW()`,
    [amount]
  );
}

export async function recordWager(amount: number): Promise<void> {
  await query(
    `INSERT INTO house_stats (date, total_wagered, ggr)
     VALUES (CURRENT_DATE, $1, $1)
     ON CONFLICT (date) DO UPDATE SET 
       total_wagered = house_stats.total_wagered + $1,
       ggr = house_stats.ggr + $1,
       updated_at = NOW()`,
    [amount]
  );
}

export async function recordDeposit(amount: number): Promise<void> {
  await query(
    `INSERT INTO house_stats (date, total_deposits)
     VALUES (CURRENT_DATE, $1)
     ON CONFLICT (date) DO UPDATE SET 
       total_deposits = house_stats.total_deposits + $1,
       updated_at = NOW()`,
    [amount]
  );
}

export async function recordWithdrawal(amount: number): Promise<void> {
  await query(
    `INSERT INTO house_stats (date, total_withdrawals)
     VALUES (CURRENT_DATE, $1)
     ON CONFLICT (date) DO UPDATE SET 
       total_withdrawals = house_stats.total_withdrawals + $1,
       updated_at = NOW()`,
    [amount]
  );
}

export async function isBotPaused(): Promise<boolean> {
  const dailyPayout = await getDailyPayout();
  const maxPayout = await getMaxDailyPayout();
  return dailyPayout >= maxPayout;
}

export async function getHouseEdge(gameType: string): Promise<number> {
  const edge = await getSettingNum(`house_edge_${gameType}`, 55);
  return edge;
}

export async function shouldBotLose(userId: number): Promise<boolean> {
  const botLoseRate = await getSettingNum("bot_lose_rate", 20);
  return Math.random() * 100 < botLoseRate;
}

export async function getForcePvPAbove(): Promise<number> {
  return getSettingNum("force_pvp_above", 10);
}

export async function getHouseProfitDashboard() {
  const today = await query(
    `SELECT * FROM house_stats WHERE date = CURRENT_DATE`
  );
  const allTime = await query(
    `SELECT 
      SUM(total_wagered) as total_wagered,
      SUM(total_paid_out) as total_paid_out,
      SUM(total_deposits) as total_deposits,
      SUM(total_withdrawals) as total_withdrawals,
      SUM(ggr) as ggr,
      SUM(bonus_cost) as bonus_cost
     FROM house_stats`
  );
  const topWinners = await query(
    `SELECT u.id, u.username, u.first_name, 
            SUM(CASE WHEN gb.winner_id = u.id THEN gb.payout ELSE 0 END) as winnings_24h
     FROM bot_users u
     JOIN game_bets gb ON gb.winner_id = u.id
     WHERE gb.completed_at > NOW() - INTERVAL '24 hours'
     GROUP BY u.id, u.username, u.first_name
     ORDER BY winnings_24h DESC
     LIMIT 5`
  );
  return {
    today: today.rows[0] || {},
    allTime: allTime.rows[0] || {},
    topWinners: topWinners.rows,
  };
}
