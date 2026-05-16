-- Cache daily closing prices for benchmark assets (BTC, SPY).
-- Avoids hitting CoinGecko / Yahoo on every cold start.
-- PRIMARY KEY (asset, date) is inherently unique — no extra constraint needed.

CREATE TABLE IF NOT EXISTS daily_benchmark_prices (
  asset      TEXT           NOT NULL,
  date       DATE           NOT NULL,
  close_usd  NUMERIC(18, 6) NOT NULL,
  created_at TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (asset, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_benchmark_prices_asset_date
  ON daily_benchmark_prices (asset, date DESC);

-- RLS: publicly readable, only service role can write
ALTER TABLE daily_benchmark_prices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "benchmark_prices_read"
  ON daily_benchmark_prices FOR SELECT
  USING (true);
