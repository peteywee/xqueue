#!/usr/bin/env bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

CONFIG="wrangler.preview.jsonc"
DB_NAME="xqueue-preview"

fail() {
  printf '\nXQUEUE PREVIEW D1 DIAGNOSTIC: FAIL\n%s\n' "$*" >&2
  exit 1
}

printf '%s\n' '============================================================'
printf '%s\n' ' XQUEUE CLOUDFLARE PREVIEW D1 DIAGNOSTIC'
printf '%s\n' '============================================================'
printf '%s\n' 'Read-only. Explicit preview config only. No production authority or D1 mutation.'

[[ -f "$CONFIG" ]] || fail "Missing explicit preview config: $CONFIG"

git diff --quiet -- "$CONFIG" || fail "$CONFIG has tracked working-tree changes."
git diff --cached --quiet -- "$CONFIG" || fail "$CONFIG has staged changes."

printf '\n=== AUTHORITY BOUNDARY ===\n'
node scripts/authority-boundary-audit.mjs || fail 'Authority boundary audit failed.'

printf '\n=== CLOUDFLARE IDENTITY ===\n'
pnpm wrangler whoami || fail 'Wrangler is not authenticated to Cloudflare.'

printf '\n=== PREVIEW D1 MIGRATION LEDGER — READ ONLY ===\n'
pnpm wrangler d1 execute "$DB_NAME" \
  --config "$CONFIG" \
  --remote \
  --yes \
  --command 'SELECT id,name,applied_at FROM d1_migrations ORDER BY id;' || \
  fail 'Could not read the explicit preview D1 migration ledger.'

printf '\n=== PREVIEW D1 TABLE INVENTORY — READ ONLY ===\n'
pnpm wrangler d1 execute "$DB_NAME" \
  --config "$CONFIG" \
  --remote \
  --yes \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" || \
  fail 'Could not read the explicit preview D1 table inventory.'

printf '\nXQUEUE PREVIEW D1 DIAGNOSTIC: PASS\n'
