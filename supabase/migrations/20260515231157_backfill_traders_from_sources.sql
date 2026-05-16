-- Migration: 20260515231157_backfill_traders_from_sources.sql
-- Backfill traders table from trader_sources.
-- Root cause (CRYAA-2077): traders was the new unified identity table but was
-- never populated from the main cron flow, which writes to trader_sources instead.
-- fetch-details and aggregate-daily-snapshots both query traders and find 0 rows,
-- breaking enrichment. compute-leaderboard will keep trader_sources up to date.

INSERT INTO traders (platform, trader_key, market_type, handle, avatar_url, is_active, last_seen_at, created_at, updated_at)
SELECT
  ts.source           AS platform,
  ts.source_trader_id AS trader_key,
  COALESCE(ts.market_type, ts.source_type, 'futures') AS market_type,
  ts.handle,
  ts.avatar_url,
  COALESCE(ts.is_active, true),
  ts.last_seen_at,
  ts.created_at,
  ts.updated_at
FROM trader_sources ts
ON CONFLICT (platform, trader_key) DO NOTHING;
