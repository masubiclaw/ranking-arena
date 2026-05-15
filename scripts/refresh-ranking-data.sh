#!/bin/bash
# Refresh trader snapshots + leaderboards for the local arena instance.
#
# Usage:
#   scripts/refresh-ranking-data.sh                # default: all known-good groups, all windows
#   GROUPS="c_hl c" scripts/refresh-ranking-data.sh
#
# Designed for an OpenClaw / crontab entry, e.g. every 30 min:
#   */30 * * * * cd /path/to/ranking-arena && scripts/refresh-ranking-data.sh >> /tmp/arena-refresh.log 2>&1

set -u
BASE_URL="${BASE_URL:-http://localhost:3000}"
CRON_SECRET="${CRON_SECRET:-local-dev-cron-secret-at-least-32-characters-long}"
# Public DEX/CEX groups that don't need API keys or VPS scrapers.
GROUPS="${GROUPS:-c_hl c g e1 f1}"
SEASONS="${SEASONS:-7D 30D 90D}"
TS="$(date -u +%FT%TZ)"

echo "[$TS] refresh starting (groups=$GROUPS, seasons=$SEASONS)"

for grp in $GROUPS; do
  start=$(date +%s)
  http=$(curl -s -o /tmp/arena-refresh-fetch.json -w "%{http_code}" \
    "$BASE_URL/api/cron/batch-fetch-traders?group=$grp" \
    -H "Authorization: Bearer $CRON_SECRET" --max-time 300)
  echo "  fetch group=$grp http=$http elapsed=$(( $(date +%s) - start ))s"
done

for s in $SEASONS; do
  start=$(date +%s)
  http=$(curl -s -o /tmp/arena-refresh-compute.json -w "%{http_code}" \
    "$BASE_URL/api/cron/compute-leaderboard?season=$s&force=1" \
    -H "Authorization: Bearer $CRON_SECRET" --max-time 300)
  echo "  compute season=$s http=$http elapsed=$(( $(date +%s) - start ))s"
done

echo "[$(date -u +%FT%TZ)] refresh complete"
