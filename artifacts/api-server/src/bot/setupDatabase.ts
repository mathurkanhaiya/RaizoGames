import { query } from "./db";

export async function setupDatabase(): Promise<void> {
  console.log("[DB] Running auto-setup...");

  await query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      id BIGINT PRIMARY KEY,
      username VARCHAR(255),
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      real_balance NUMERIC(18,8) NOT NULL DEFAULT 0,
      bonus_balance NUMERIC(18,8) NOT NULL DEFAULT 0,
      total_wagered NUMERIC(18,8) NOT NULL DEFAULT 0,
      total_deposited NUMERIC(18,8) NOT NULL DEFAULT 0,
      referral_code VARCHAR(32) UNIQUE,
      referral_id BIGINT REFERENCES bot_users(id),
      is_vip BOOLEAN NOT NULL DEFAULT FALSE,
      is_banned BOOLEAN NOT NULL DEFAULT FALSE,
      newbie_bonus_given BOOLEAN NOT NULL DEFAULT FALSE,
      newbie_bonus_expires_at TIMESTAMPTZ,
      wager_requirement NUMERIC(18,8) NOT NULL DEFAULT 0,
      win_streak INT NOT NULL DEFAULT 0,
      loss_streak INT NOT NULL DEFAULT 0,
      consecutive_bot_losses INT NOT NULL DEFAULT 0,
      last_daily_claim TIMESTAMPTZ,
      last_weekly_claim TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES bot_users(id),
      type VARCHAR(64) NOT NULL,
      amount NUMERIC(18,8) NOT NULL,
      balance_after NUMERIC(18,8),
      description TEXT,
      ref_id VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES bot_users(id),
      method VARCHAR(32) NOT NULL,
      amount NUMERIC(18,8) NOT NULL DEFAULT 0,
      usd_amount NUMERIC(18,8) NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      tx_hash VARCHAR(255),
      stars_count INT,
      oxapay_order_id VARCHAR(255),
      locked_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES bot_users(id),
      amount NUMERIC(18,8) NOT NULL,
      fee NUMERIC(18,8) NOT NULL DEFAULT 0,
      net_amount NUMERIC(18,8) NOT NULL,
      address VARCHAR(255),
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS game_bets (
      id SERIAL PRIMARY KEY,
      creator_id BIGINT NOT NULL REFERENCES bot_users(id),
      opponent_id BIGINT REFERENCES bot_users(id),
      game_type VARCHAR(32) NOT NULL,
      mode VARCHAR(16) NOT NULL DEFAULT 'pvp',
      bet_amount NUMERIC(18,8) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'waiting',
      winner_id BIGINT REFERENCES bot_users(id),
      creator_result VARCHAR(64),
      opponent_result VARCHAR(64),
      creator_choice VARCHAR(32),
      opponent_choice VARCHAR(32),
      house_fee NUMERIC(18,8) NOT NULL DEFAULT 0,
      payout NUMERIC(18,8) NOT NULL DEFAULT 0,
      group_chat_id BIGINT,
      message_id BIGINT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS risk_settings (
      id SERIAL PRIMARY KEY,
      key VARCHAR(128) UNIQUE NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS house_stats (
      id SERIAL PRIMARY KEY,
      date DATE UNIQUE NOT NULL DEFAULT CURRENT_DATE,
      total_wagered NUMERIC(18,8) NOT NULL DEFAULT 0,
      total_paid_out NUMERIC(18,8) NOT NULL DEFAULT 0,
      ggr NUMERIC(18,8) NOT NULL DEFAULT 0,
      total_deposits NUMERIC(18,8) NOT NULL DEFAULT 0,
      total_withdrawals NUMERIC(18,8) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      task_type VARCHAR(64) NOT NULL,
      target_value INT NOT NULL DEFAULT 1,
      reward NUMERIC(18,8) NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_tasks (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES bot_users(id),
      task_id INT NOT NULL REFERENCES tasks(id),
      progress INT NOT NULL DEFAULT 0,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      claimed BOOLEAN NOT NULL DEFAULT FALSE,
      completed_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      UNIQUE(user_id, task_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bonus_codes (
      id SERIAL PRIMARY KEY,
      code VARCHAR(64) UNIQUE NOT NULL,
      amount NUMERIC(18,8) NOT NULL,
      max_uses INT NOT NULL DEFAULT 1,
      uses INT NOT NULL DEFAULT 0,
      created_by BIGINT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bonus_code_uses (
      id SERIAL PRIMARY KEY,
      code_id INT NOT NULL REFERENCES bonus_codes(id),
      user_id BIGINT NOT NULL REFERENCES bot_users(id),
      used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(code_id, user_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS referral_earnings (
      id SERIAL PRIMARY KEY,
      referrer_id BIGINT NOT NULL REFERENCES bot_users(id),
      referee_id BIGINT NOT NULL REFERENCES bot_users(id),
      tier INT NOT NULL DEFAULT 1,
      amount NUMERIC(18,8) NOT NULL,
      source_type VARCHAR(32),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Seed default risk settings
  const defaults = [
    ["house_edge_dice", "5"],
    ["house_edge_slots", "10"],
    ["house_edge_basketball", "5"],
    ["house_edge_bowling", "5"],
    ["house_edge_darts", "5"],
    ["house_edge_football", "5"],
    ["house_edge_rps", "5"],
    ["max_bet", "100"],
    ["min_bet", "0.10"],
    ["daily_loss_limit", "500"],
    ["withdrawal_fee_pct", "5"],
    ["min_withdrawal", "5"],
  ];
  for (const [key, value] of defaults) {
    await query(
      `INSERT INTO risk_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }

  // Seed default tasks
  const tasks = [
    ["First Deposit", "Make your first deposit", "make_deposit", 1, 0.05],
    ["Play 5 Games", "Play 5 games (any mode)", "play_games", 5, 0.10],
    ["Invite a Friend", "Refer a friend who deposits", "referral_deposit", 1, 0.20],
    ["Play 20 Games", "Play 20 games (any mode)", "play_games", 20, 0.25],
    ["Big Depositor", "Deposit $10 or more", "make_deposit", 10, 0.50],
    ["Wager $1", "Wager a total of $1", "wager_amount", 1, 0.10],
    ["Wager $5", "Wager a total of $5", "wager_amount", 5, 0.15],
    ["Wager $10", "Wager a total of $10", "wager_amount", 10, 0.20],
  ];
  for (const [name, description, task_type, target_value, reward] of tasks) {
    await query(
      `INSERT INTO tasks (name, description, task_type, target_value, reward)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [name, description, task_type, target_value, reward]
    );
  }

  console.log("[DB] Auto-setup complete.");
}
