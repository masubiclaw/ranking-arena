-- RPC for writing equity-curve-derived max_drawdown back into trader_snapshots_v2.
-- Only fills rows where max_drawdown IS NULL (never overwrites native/raw values).
-- Merges dd_source = 'derived' into the quality_flags JSON column.

CREATE OR REPLACE FUNCTION bulk_update_derived_drawdown(updates jsonb)
RETURNS integer AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH parsed AS (
    SELECT * FROM jsonb_to_recordset(updates) AS u(
      platform text, trader_key text, "window" text,
      max_drawdown double precision
    )
  )
  UPDATE trader_snapshots_v2 t SET
    max_drawdown = p.max_drawdown,
    quality_flags = COALESCE(t.quality_flags, '{}'::jsonb)
                    || jsonb_build_object('dd_source', 'derived'),
    updated_at = now()
  FROM parsed p
  WHERE t.platform = p.platform
    AND t.trader_key = p.trader_key
    AND UPPER(t."window") = UPPER(p."window")
    AND t.max_drawdown IS NULL
    AND p.max_drawdown IS NOT NULL
    AND p.max_drawdown > 0
    AND p.max_drawdown <= 100;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
