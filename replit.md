# RAIZO GAMES — PvP Casino Telegram Bot

## Overview

A full-featured PvP casino Telegram bot (@RaizoPvPBot) with auto deposits, withdrawals, PvP/bot games, referral system, leaderboard, tasks, and admin panel. Built on Node.js/TypeScript running in the API server.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + raw pg queries
- **Telegram**: node-telegram-bot-api (polling mode)
- **Build**: esbuild (CJS bundle)

## Architecture

The Telegram bot runs inside the API server (`artifacts/api-server`). It starts automatically when the server starts.

```
artifacts/api-server/src/
├── bot/
│   ├── bot.ts              # Main bot orchestrator, commands, callbacks
│   ├── db.ts               # DB connection pool
│   ├── utils.ts            # Shared utilities
│   ├── games/
│   │   └── engine.ts       # Game logic, dice simulation
│   ├── handlers/
│   │   ├── start.ts        # /start, welcome, newbie bonus
│   │   ├── balance.ts      # /balance, transaction history
│   │   ├── deposit.ts      # USDT/TON/Stars deposits
│   │   ├── withdraw.ts     # Withdrawal requests
│   │   ├── play.ts         # Game flows (PvP + bot)
│   │   ├── referral.ts     # Referral system
│   │   ├── leaderboard.ts  # Rankings
│   │   ├── tasks.ts        # Tasks & rewards
│   │   ├── admin.ts        # Admin panel
│   │   └── keyboard.ts     # All inline keyboards
│   └── services/
│       ├── userService.ts  # User CRUD, balance, streaks
│       ├── gameService.ts  # Bet creation, completion, payout
│       ├── depositService.ts # OxaPay + TON + Stars deposits
│       ├── withdrawService.ts # Withdrawal management
│       └── riskService.ts  # House edge, risk settings, stats
└── routes/
    └── webhook.ts          # OxaPay webhook endpoint
```

## Database Tables

- `bot_users` — user accounts, balances, referral info
- `deposits` — deposit records (USDT, TON, Stars)
- `withdrawals` — withdrawal requests and status
- `game_bets` — all bets/games history
- `referral_earnings` — referral commission log
- `tasks` + `user_tasks` — task system
- `house_stats` — daily GGR/NGR stats
- `risk_settings` — admin-configurable settings
- `transactions` — full ledger log

## Environment Variables

- `TELEGRAM_BOT_TOKEN` — Bot token
- `OXAPAY_API_KEY` — OxaPay payment gateway
- `ADMIN_TELEGRAM_ID` — Admin's Telegram user ID (2139807311)
- `TON_WALLET` — TON deposit wallet address
- `DATABASE_URL` — PostgreSQL connection string

## Key Commands

- `pnpm run typecheck` — full typecheck
- `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-server run dev` — run server locally

## Bot Commands

- `/start` — Register, show welcome + newbie bonus
- `/play` — Play games (PvP or vs Bot)
- `/bet <game> <amount>` — Quick bet
- `/balance` — Check wallet
- `/deposit` — Deposit funds
- `/withdraw` — Withdraw USDT
- `/referral` — Referral system
- `/tasks` — Complete tasks for rewards
- `/leaderboard` — Rankings
- `/join` — Quick join open PvP bets
- `/admin` — Admin panel (admin only)
- `/set <key> <value>` — Change risk settings (admin only)
- `/addbalance <userId> <amount>` — Admin add balance
- `/ban <userId>` — Admin ban user

## Admin Risk Controls

```
/set house_edge_dice 55
/set bot_lose_rate 20
/set max_daily_payout 500
/set force_pvp_above 10
/set wager_multiplier 2
```
