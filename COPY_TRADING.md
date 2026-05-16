# Copy Trading — Live-Go Checklist

This document covers operational readiness for the copy-trading subsystem
(`app/api/cron/reconcile-positions`, `app/api/cron/execute-copy-trades`, etc.).

---

## 1. Wallet Setup (mandatory before live execution)

The reconciler reads `follower_wallets` to compare intent vs reality.
The table was seeded with the zero-address placeholder
(`0x0000000000000000000000000000000000000000`) — **replace it before any live run**.

### Set the real follower wallet

```bash
# Requires DATABASE_URL or (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
scripts/set-follower-wallet.sh <follower> <platform> <address>

# Example (Hyperliquid mainnet)
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-jwt>
scripts/set-follower-wallet.sh bot1 hyperliquid 0xYourAPIWalletAddress
```

The address must be the **API-wallet address** whose private key is stored in
`HL_PRIVATE_KEY` (Hyperliquid) or the equivalent signer env var for the target
platform.  The script rejects the zero-address to prevent accidental no-ops.

### Verify the upsert

```bash
curl -s "${SUPABASE_URL}/rest/v1/follower_wallets?select=*" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" | jq .
# Expected: address field is your real wallet, NOT 0x0000…
```

---

## 2. Reconciler Smoke Test

After the wallet is configured, trigger a manual reconcile and verify zero drift
on a freshly-funded, position-free account:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "${NEXT_PUBLIC_APP_URL}/api/cron/reconcile-positions" | jq .
```

Expected response when clean:

```json
{
  "ok": true,
  "followers": { "bot1": { "intent": 0, "actual": 0, "drift": 0 } },
  "total_drifts_recorded": 0,
  "drifts": []
}
```

If `total_drifts_recorded > 0` on a freshly-funded account:

| drift_type    | Likely cause                                      | Action                                      |
|---------------|---------------------------------------------------|---------------------------------------------|
| `missing`     | `dry_run_orders` has un-filled intents            | Flush stale dry-run rows or re-seed DB      |
| `orphan`      | Pre-existing positions in wallet before bot start | Close manually on exchange, then re-run     |
| `side_mismatch` / `size_drift` | Partial fills from a prior test run | Reconcile and close old positions |

---

## 3. Env Vars Checklist

| Var                       | Purpose                                          | Required for live? |
|---------------------------|--------------------------------------------------|--------------------|
| `HL_PRIVATE_KEY`          | Hyperliquid API-wallet signer key                | ✅ Yes              |
| `HL_WALLET_ADDRESS`       | Corresponds to `HL_PRIVATE_KEY` public address   | ✅ Yes              |
| `CRON_SECRET`             | Auth header for all `/api/cron/*` routes         | ✅ Yes              |
| `NEXT_PUBLIC_APP_URL`     | Base URL for manual curl tests                   | Recommended         |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin DB access (wallet upsert, reconciler)    | ✅ Yes              |

---

## 4. Go / No-Go Gate

Before enabling live execution confirm all of the following:

- [ ] `follower_wallets` has a real (non-zero) address for every active follower
- [ ] `reconcile-positions` returns `total_drifts_recorded: 0` on a clean account
- [ ] `HL_PRIVATE_KEY` and `HL_WALLET_ADDRESS` are set in production secrets
- [ ] The API wallet has been funded (Hyperliquid: minimum ~$20 USDC for gas)
- [ ] Dry-run mode is disabled (`DRY_RUN=false` or equivalent flag)
- [ ] Execution cron is enabled in `vercel.json` (change `inactive` → active schedule)

---

## 5. References

- Reconciler route: `app/api/cron/reconcile-positions/route.ts`
- Wallet setup script: `scripts/set-follower-wallet.sh`
- Superforecaster ranking logic: `SUPERFORECASTER_RANKING.md`
- Position fetch: `lib/data/positions.ts`
- Hyperliquid signer: `lib/copy-trading/hl-signer.ts` (or equivalent)
