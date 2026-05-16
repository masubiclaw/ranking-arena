#!/bin/bash
# set-follower-wallet.sh — Upsert a follower wallet address into follower_wallets
#
# The reconciler reads follower_wallets to know which on-chain address to compare
# against recorded dry_run_orders intent.  This script replaces the placeholder
# 0x0000… address with the real API-wallet address whose private key lives in
# HL_PRIVATE_KEY (or whichever env var your signer uses).
#
# Usage:
#   scripts/set-follower-wallet.sh <follower> <platform> <address>
#
# Arguments:
#   follower   Logical follower name (e.g. "bot1")
#   platform   Exchange platform slug (e.g. "hyperliquid")
#   address    Wallet address (e.g. 0xabc…)
#
# Required env vars (one of):
#   DATABASE_URL           — direct Postgres connection string
#   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — Supabase REST API fallback
#
# Exit code: 0 on success, 1 on error

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
if [[ $# -ne 3 ]]; then
  echo -e "${RED}Error: wrong number of arguments${NC}"
  echo "Usage: $0 <follower> <platform> <address>"
  echo "  follower  — logical follower name (e.g. bot1)"
  echo "  platform  — exchange slug (e.g. hyperliquid)"
  echo "  address   — wallet address (e.g. 0xabc...)"
  exit 1
fi

FOLLOWER="$1"
PLATFORM="$2"
ADDRESS="$3"

# Basic address sanity check (must start with 0x and be at least 10 chars)
if [[ ! "$ADDRESS" =~ ^0x[0-9a-fA-F]{10,} ]]; then
  echo -e "${RED}Error: address looks invalid (expected 0x-prefixed hex): $ADDRESS${NC}"
  exit 1
fi

# Reject the placeholder
if [[ "$ADDRESS" == "0x0000000000000000000000000000000000000000" ]]; then
  echo -e "${RED}Error: refusing to set the zero-address placeholder. Provide a real wallet.${NC}"
  exit 1
fi

echo -e "${YELLOW}Setting follower wallet:${NC}"
echo "  follower : $FOLLOWER"
echo "  platform : $PLATFORM"
echo "  address  : $ADDRESS"

# ---------------------------------------------------------------------------
# Upsert via DATABASE_URL (psql) or Supabase REST
# ---------------------------------------------------------------------------
SQL="INSERT INTO follower_wallets (follower, platform, address)
VALUES ('$FOLLOWER', '$PLATFORM', '$ADDRESS')
ON CONFLICT (follower, platform)
DO UPDATE SET address = EXCLUDED.address, updated_at = now()
RETURNING follower, platform, address;"

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo ""
  echo "Using DATABASE_URL (psql)…"
  result=$(psql "$DATABASE_URL" -c "$SQL" 2>&1)
  echo "$result"
elif [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo ""
  echo "Using Supabase REST API…"
  response=$(curl -s -w "\n%{http_code}" -X POST \
    "${SUPABASE_URL}/rest/v1/follower_wallets" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates,return=representation" \
    -d "{\"follower\":\"$FOLLOWER\",\"platform\":\"$PLATFORM\",\"address\":\"$ADDRESS\"}")
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)
  if [[ "$http_code" != "200" && "$http_code" != "201" ]]; then
    echo -e "${RED}Error: Supabase returned HTTP $http_code${NC}"
    echo "$body"
    exit 1
  fi
  echo "$body"
else
  echo -e "${RED}Error: set DATABASE_URL or (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)${NC}"
  echo ""
  echo "Examples:"
  echo "  export DATABASE_URL=postgresql://user:pass@host/db"
  echo "  export SUPABASE_URL=https://xxx.supabase.co"
  echo "  export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>"
  exit 1
fi

echo ""
echo -e "${GREEN}Done. follower_wallets updated.${NC}"
echo ""
echo "Next steps:"
echo "  1. Verify: curl -s \$SUPABASE_URL/rest/v1/follower_wallets ..."
echo "  2. Re-run reconciler: curl -H 'Authorization: Bearer \$CRON_SECRET' \\"
echo "       \$NEXT_PUBLIC_APP_URL/api/cron/reconcile-positions"
echo "  3. Drifts should collapse to zero for a freshly-funded account with no active positions."
