#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXPECTED_BRANCH="cf-runtime-integration"
DB_NAME="xqueue-production"

fail() {
  printf '\nXQUEUE PREVIEW D1 DIAGNOSTIC: FAIL\n%s\n' "$*" >&2
  exit 1
}

printf '%s\n' '============================================================'
printf '%s\n' ' XQUEUE CLOUDFLARE PREVIEW D1 DIAGNOSTIC'
printf '%s\n' '============================================================'
printf '%s\n' 'Read-only preflight. No migration or production authority changes occur before the final rehearsal call.'

[[ "$(git branch --show-current)" == "$EXPECTED_BRANCH" ]] || \
  fail "Expected branch $EXPECTED_BRANCH; found $(git branch --show-current)."

git fetch --quiet origin "$EXPECTED_BRANCH"
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$EXPECTED_BRANCH")"
[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] || \
  fail "Local HEAD $LOCAL_SHA does not equal origin/$EXPECTED_BRANCH $REMOTE_SHA."

git diff --quiet || fail 'Tracked working-tree changes are present.'
git diff --cached --quiet || fail 'Staged changes are present.'

printf '\n=== AUTHORITY BOUNDARY ===\n'
node scripts/authority-boundary-audit.mjs

printf '\n=== CLOUDFLARE IDENTITY ===\n'
pnpm wrangler whoami || fail 'Wrangler is not authenticated to Cloudflare.'

printf '\n=== PREVIEW D1 MIGRATION LEDGER — READ ONLY ===\n'
# Deliberately do not use --json or command substitution here. If Wrangler fails,
# the exact account/API/preview-resolution error remains visible to the operator.
pnpm wrangler d1 execute "$DB_NAME" \
  --remote \
  --preview \
  --yes \
  --command 'SELECT id,name,applied_at FROM d1_migrations ORDER BY id;' || \
  fail 'Could not read the preview D1 migration ledger.'

printf '\n=== PREVIEW D1 TABLE INVENTORY — READ ONLY ===\n'
pnpm wrangler d1 execute "$DB_NAME" \
  --remote \
  --preview \
  --yes \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" || \
  fail 'Could not read the preview D1 table inventory.'

printf '\nRead-only preview D1 preflight passed. Starting the guarded lease rehearsal.\n'
exec bash scripts/cloudflare-preview-lease-rehearsal.sh
