-- Migration: 20260516180107_shrinkage_snapshots.sql
-- Created: 2026-05-17T01:01:07Z
-- Description: Persistence for empirical-Bayes shrinkage outputs (CRYAA-2137 /
-- integration-ranking-arena plan §D1). Adds trader_shrinkage_snapshots
-- (per-trader/window posterior) and shrinkage_population_runs (per-(window,
-- day) population parameters). The compute-shrinkage cron upserts into both
-- tables hourly; the snapshot read endpoint consumes them so /api/top-traders
-- can serve constant-time reads without rerunning the population scan.

-- Up

CREATE TABLE IF NOT EXISTS trader_shrinkage_snapshots (
    id                 BIGSERIAL PRIMARY KEY,
    window             TEXT      NOT NULL,
    platform           TEXT      NOT NULL,
    trader_key         TEXT      NOT NULL,
    observed           DOUBLE PRECISION,
    shrunk             DOUBLE PRECISION,
    posterior_sd       DOUBLE PRECISION,
    weight_to_prior    DOUBLE PRECISION,
    p_superforecaster  DOUBLE PRECISION,
    mu_pop             DOUBLE PRECISION,
    tau_sq             DOUBLE PRECISION,
    eligible_n         INTEGER,
    sf_threshold       DOUBLE PRECISION,
    sf_fraction        DOUBLE PRECISION,
    computed_at        TIMESTAMPTZ NOT NULL
);

-- Per plan §D1 upsert key: one row per (platform, trader_key, window) per day.
-- Re-running the cron in the same day overwrites that day's posterior; the
-- index on computed_at preserves history across days for backtest replay.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_shrinkage_snapshots_unique_daily
    ON trader_shrinkage_snapshots(window, platform, trader_key, ((computed_at AT TIME ZONE 'UTC')::date));

CREATE INDEX IF NOT EXISTS idx_trader_shrinkage_snapshots_key_time
    ON trader_shrinkage_snapshots(window, platform, trader_key, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_trader_shrinkage_snapshots_window_time
    ON trader_shrinkage_snapshots(window, computed_at DESC);

CREATE TABLE IF NOT EXISTS shrinkage_population_runs (
    id                 BIGSERIAL PRIMARY KEY,
    window             TEXT      NOT NULL,
    mu_pop             DOUBLE PRECISION,
    tau_sq             DOUBLE PRECISION,
    eligible_n         INTEGER,
    sf_threshold       DOUBLE PRECISION,
    sf_fraction        DOUBLE PRECISION,
    median_trades      DOUBLE PRECISION,
    computed_at        TIMESTAMPTZ NOT NULL
);

-- One population row per (window, UTC day). Subsequent runs in the same day
-- overwrite via ON CONFLICT DO UPDATE on this key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shrinkage_population_runs_unique_daily
    ON shrinkage_population_runs(window, ((computed_at AT TIME ZONE 'UTC')::date));

CREATE INDEX IF NOT EXISTS idx_shrinkage_population_runs_window_time
    ON shrinkage_population_runs(window, computed_at DESC);
