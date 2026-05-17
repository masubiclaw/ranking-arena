-- Migration: 20260517151752_trader_portfolio_snapshots.sql
-- Created: 2026-05-17T15:17:52Z
-- Description: Hourly trader-portfolio snapshots for historical replay
-- (CRYAA-2154). The hourly cron persists the current open positions of
-- every eligible-pool trader (top-K by p_superforecaster) so ACP's weekly
-- forward-validation script can replay cohort positions at T-N rather than
-- depending on the live `/api/v1/trader-portfolios` upstream.
--
-- One row per (platform, trader_key, captured_at) carries the full positions
-- array as JSONB — the live portfolio endpoint normalizes its `Position[]` to
-- this shape (`symbol, side, size, entry_price, mark_price, leverage,
-- notional_usd, unrealized_pnl_usd, liq_price`).

-- Up

CREATE TABLE IF NOT EXISTS trader_portfolio_snapshots (
    id                    BIGSERIAL PRIMARY KEY,
    platform              TEXT        NOT NULL,
    trader_key            TEXT        NOT NULL,
    captured_at           TIMESTAMPTZ NOT NULL,
    account_value_usd     DOUBLE PRECISION,
    total_notional_usd    DOUBLE PRECISION,
    positions             JSONB       NOT NULL DEFAULT '[]'::jsonb,
    source                TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (platform, trader_key, captured_at hour). Re-running the cron
-- in the same hour overwrites that hour's snapshot for the same trader; the
-- (trader_key, captured_at DESC) index serves the time-travel read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_portfolio_snapshots_unique_hourly
    ON trader_portfolio_snapshots(
        platform,
        trader_key,
        date_trunc('hour', captured_at AT TIME ZONE 'UTC')
    );

CREATE INDEX IF NOT EXISTS idx_trader_portfolio_snapshots_key_time
    ON trader_portfolio_snapshots(platform, trader_key, captured_at DESC);

-- Drives /api/v1/health's portfolio_snapshot_cron_age_seconds.
CREATE INDEX IF NOT EXISTS idx_trader_portfolio_snapshots_time
    ON trader_portfolio_snapshots(captured_at DESC);
