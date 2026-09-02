#!/usr/bin/env bash
set -Eeuo pipefail

# Remote PREVIEW-only rehearsal for migration 0003 and publication-lease semantics.
# This script never targets production D1, deploys a Worker, touches R2, reads X credentials,
# or grants Cloudflare publication authority.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXPECTED_BRANCH="cf-runtime-integration"
DB_NAME="xqueue-production"
PREVIEW_FLAGS=(--remote --preview)
PROBE_OWNER_1="xqueue-preview-probe-owner-1"
PROBE_OWNER_2="xqueue-preview-probe-owner-2"
PROBE_ACQ_1="xqueue-preview-probe-acq-1"
PROBE_ACQ_2="xqueue-preview-probe-acq-2"
T0=1800000000000
TTL=60000
T_BEFORE=$((T0 + 30000))
T_EXPIRY=$((T0 + TTL))
T_RELEASE=$((T_EXPIRY + 1000))

fail() {
  printf '\nXQUEUE PREVIEW LEASE REHEARSAL: FAIL\n%s\n' "$*" >&2
  exit 1
}

printf '%s\n' '============================================================'
printf '%s\n' ' XQUEUE CLOUDFLARE PREVIEW LEASE REHEARSAL'
printf '%s\n' '============================================================'
printf '%s\n' 'Scope: preview D1 only; no production authority changes.'

[[ "$(git branch --show-current)" == "$EXPECTED_BRANCH" ]] || \
  fail "Expected branch $EXPECTED_BRANCH; found $(git branch --show-current)."

git fetch --quiet origin "$EXPECTED_BRANCH"
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$EXPECTED_BRANCH")"
[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] || \
  fail "Local HEAD $LOCAL_SHA does not equal origin/$EXPECTED_BRANCH $REMOTE_SHA."

git diff --quiet || fail 'Tracked working-tree changes are present.'
git diff --cached --quiet || fail 'Staged changes are present.'

node scripts/authority-boundary-audit.mjs
pnpm wrangler deploy --dry-run --outdir /tmp/xqueue-preview-lease-worker >/tmp/xqueue-preview-lease-dryrun.log

grep -q 'env.DB' /tmp/xqueue-preview-lease-dryrun.log || fail 'Wrangler dry-run did not expose DB binding.'
grep -q 'env.MEDIA' /tmp/xqueue-preview-lease-dryrun.log || fail 'Wrangler dry-run did not expose MEDIA binding.'

# Every SQL call is mechanically pinned to the configured preview database.
d1_json() {
  local sql="$1"
  pnpm wrangler d1 execute "$DB_NAME" "${PREVIEW_FLAGS[@]}" --yes --json --command "$sql"
}

json_assert() {
  local expression="$1"
  node -e '
    const fs = require("node:fs");
    const raw = JSON.parse(fs.readFileSync(0, "utf8"));
    const batches = Array.isArray(raw) ? raw : [raw];
    const rows = batches.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
    const metas = batches.map((entry) => entry?.meta ?? {});
    const ok = Function("rows", "metas", `return Boolean(${process.argv[1]})`)(rows, metas);
    if (!ok) {
      console.error(JSON.stringify({ rows, metas }, null, 2));
      process.exit(1);
    }
  ' "$expression"
}

printf '\n=== PRE-MIGRATION LEDGER ===\n'
PRE_MIGRATIONS="$(d1_json 'SELECT name FROM d1_migrations ORDER BY id;')"
printf '%s\n' "$PRE_MIGRATIONS" | json_assert \
  'rows.map(r => r.name).join(",") === "0001_xqueue_runtime.sql,0002_runtime_evidence.sql" || rows.map(r => r.name).join(",") === "0001_xqueue_runtime.sql,0002_runtime_evidence.sql,0003_publication_lease.sql"' || \
  fail 'Preview migration ledger contains an unexpected migration set.'

if ! printf '%s\n' "$PRE_MIGRATIONS" | grep -q '0003_publication_lease.sql'; then
  printf '\n=== APPLYING 0003 TO PREVIEW ONLY ===\n'
  printf 'y\n' | pnpm wrangler d1 migrations apply "$DB_NAME" "${PREVIEW_FLAGS[@]}"
else
  printf '\n0003 is already applied to preview; continuing with the semantic rehearsal.\n'
fi

printf '\n=== POST-MIGRATION SCHEMA ===\n'
POST_MIGRATIONS="$(d1_json 'SELECT name FROM d1_migrations ORDER BY id;')"
printf '%s\n' "$POST_MIGRATIONS" | json_assert \
  'rows.map(r => r.name).join(",") === "0001_xqueue_runtime.sql,0002_runtime_evidence.sql,0003_publication_lease.sql"' || \
  fail 'Preview migration ledger is not exactly 0001/0002/0003 after apply.'

SCHEMA_TABLES="$(d1_json "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('publication_leases','publication_lease_events') ORDER BY name;")"
printf '%s\n' "$SCHEMA_TABLES" | json_assert \
  'rows.map(r => r.name).join(",") === "publication_lease_events,publication_leases"' || \
  fail 'Preview lease tables are incomplete.'

SCHEMA_TRIGGERS="$(d1_json "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'publication_lease_%_audit' ORDER BY name;")"
printf '%s\n' "$SCHEMA_TRIGGERS" | json_assert \
  'rows.map(r => r.name).join(",") === "publication_lease_initial_acquire_audit,publication_lease_release_audit,publication_lease_takeover_audit"' || \
  fail 'Preview lease audit triggers are incomplete.'

QUICK_CHECK="$(d1_json 'PRAGMA quick_check;')"
printf '%s\n' "$QUICK_CHECK" | json_assert \
  'rows.length === 1 && String(Object.values(rows[0])[0]).toLowerCase() === "ok"' || \
  fail 'Preview D1 PRAGMA quick_check did not return ok.'

# Clean only this script's fixed probe identities. This makes a retry safe after an interrupted run
# without deleting any unrelated lease evidence.
cleanup_probe() {
  set +e
  d1_json "DELETE FROM publication_lease_events WHERE acquisition_id IN ('$PROBE_ACQ_1','$PROBE_ACQ_2');" >/dev/null 2>&1
  d1_json "DELETE FROM publication_leases WHERE lease_name='publisher' AND generation <= 2 AND (owner_token IS NULL OR owner_token IN ('$PROBE_OWNER_1','$PROBE_OWNER_2'));" >/dev/null 2>&1
}
trap cleanup_probe EXIT

cleanup_probe

LEASE_COUNT="$(d1_json 'SELECT COUNT(*) AS count FROM publication_leases;')"
printf '%s\n' "$LEASE_COUNT" | json_assert 'Number(rows[0]?.count) === 0' || \
  fail 'Preview publication_leases contains non-probe state; refusing rehearsal.'

EVENT_COUNT="$(d1_json 'SELECT COUNT(*) AS count FROM publication_lease_events;')"
printf '%s\n' "$EVENT_COUNT" | json_assert 'Number(rows[0]?.count) === 0' || \
  fail 'Preview publication_lease_events contains non-probe state; refusing rehearsal.'

ACQUIRE_SQL_1="INSERT INTO publication_leases (lease_name,owner_token,acquisition_id,generation,acquired_at_ms,expires_at_ms,updated_at_ms) VALUES ('publisher','$PROBE_OWNER_1','$PROBE_ACQ_1',1,$T0,$T_EXPIRY,$T0) ON CONFLICT(lease_name) DO UPDATE SET owner_token=excluded.owner_token, acquisition_id=excluded.acquisition_id, generation=publication_leases.generation+1, acquired_at_ms=excluded.acquired_at_ms, expires_at_ms=excluded.expires_at_ms, updated_at_ms=excluded.updated_at_ms WHERE publication_leases.owner_token IS NULL OR publication_leases.expires_at_ms <= excluded.acquired_at_ms;"
ACQUIRE_SQL_2_BEFORE="INSERT INTO publication_leases (lease_name,owner_token,acquisition_id,generation,acquired_at_ms,expires_at_ms,updated_at_ms) VALUES ('publisher','$PROBE_OWNER_2','$PROBE_ACQ_2',1,$T_BEFORE,$((T_BEFORE + TTL)),$T_BEFORE) ON CONFLICT(lease_name) DO UPDATE SET owner_token=excluded.owner_token, acquisition_id=excluded.acquisition_id, generation=publication_leases.generation+1, acquired_at_ms=excluded.acquired_at_ms, expires_at_ms=excluded.expires_at_ms, updated_at_ms=excluded.updated_at_ms WHERE publication_leases.owner_token IS NULL OR publication_leases.expires_at_ms <= excluded.acquired_at_ms;"
ACQUIRE_SQL_2_EXPIRY="INSERT INTO publication_leases (lease_name,owner_token,acquisition_id,generation,acquired_at_ms,expires_at_ms,updated_at_ms) VALUES ('publisher','$PROBE_OWNER_2','$PROBE_ACQ_2',1,$T_EXPIRY,$((T_EXPIRY + TTL)),$T_EXPIRY) ON CONFLICT(lease_name) DO UPDATE SET owner_token=excluded.owner_token, acquisition_id=excluded.acquisition_id, generation=publication_leases.generation+1, acquired_at_ms=excluded.acquired_at_ms, expires_at_ms=excluded.expires_at_ms, updated_at_ms=excluded.updated_at_ms WHERE publication_leases.owner_token IS NULL OR publication_leases.expires_at_ms <= excluded.acquired_at_ms;"

printf '\n=== REAL D1 LEASE SEMANTICS ===\n'

# D1 meta.changes is based on sqlite3_total_changes(), so trigger-written audit rows contribute to
# it. The acceptance oracle is therefore the resulting lease row + exact audit trail, not an exact
# meta.changes value.
FIRST="$(d1_json "$ACQUIRE_SQL_1")"
printf 'First acquisition D1 metadata:\n%s\n' "$FIRST"

ROW1="$(d1_json 'SELECT * FROM publication_leases WHERE lease_name="publisher";')"
printf '%s\n' "$ROW1" | json_assert \
  "rows.length === 1 && rows[0].owner_token === '$PROBE_OWNER_1' && rows[0].acquisition_id === '$PROBE_ACQ_1' && Number(rows[0].generation) === 1 && Number(rows[0].acquired_at_ms) === $T0 && Number(rows[0].expires_at_ms) === $T_EXPIRY" || \
  fail 'First lease row does not match the exact acquisition identity.'

EVENTS1="$(d1_json 'SELECT generation,owner_token,acquisition_id,event_type,event_at_ms,detail FROM publication_lease_events ORDER BY id;')"
printf '%s\n' "$EVENTS1" | json_assert \
  "rows.length === 1 && rows[0].generation == 1 && rows[0].owner_token === '$PROBE_OWNER_1' && rows[0].acquisition_id === '$PROBE_ACQ_1' && rows[0].event_type === 'acquired' && rows[0].event_at_ms == $T0 && rows[0].detail === 'initial-acquisition'" || \
  fail 'First acquisition did not create exactly one matching audit grant.'

BLOCKED="$(d1_json "$ACQUIRE_SQL_2_BEFORE")"
printf 'Blocked contender D1 metadata:\n%s\n' "$BLOCKED"

ROW_BLOCKED="$(d1_json 'SELECT * FROM publication_leases WHERE lease_name="publisher";')"
printf '%s\n' "$ROW_BLOCKED" | json_assert \
  "rows.length === 1 && rows[0].owner_token === '$PROBE_OWNER_1' && rows[0].acquisition_id === '$PROBE_ACQ_1' && Number(rows[0].generation) === 1 && Number(rows[0].expires_at_ms) === $T_EXPIRY" || \
  fail 'Blocked contender changed the active lease.'

EVENTS_BLOCKED="$(d1_json 'SELECT generation,owner_token,acquisition_id,event_type,event_at_ms,detail FROM publication_lease_events ORDER BY id;')"
printf '%s\n' "$EVENTS_BLOCKED" | json_assert \
  "rows.length === 1 && rows[0].acquisition_id === '$PROBE_ACQ_1' && rows[0].event_type === 'acquired'" || \
  fail 'Blocked contender created unexpected audit evidence.'

TAKEOVER="$(d1_json "$ACQUIRE_SQL_2_EXPIRY")"
printf 'Exact-expiry takeover D1 metadata:\n%s\n' "$TAKEOVER"

ROW2="$(d1_json 'SELECT * FROM publication_leases WHERE lease_name="publisher";')"
printf '%s\n' "$ROW2" | json_assert \
  "rows.length === 1 && rows[0].owner_token === '$PROBE_OWNER_2' && rows[0].acquisition_id === '$PROBE_ACQ_2' && Number(rows[0].generation) === 2 && Number(rows[0].acquired_at_ms) === $T_EXPIRY && Number(rows[0].expires_at_ms) === $((T_EXPIRY + TTL))" || \
  fail 'Takeover did not fence the old handle with generation 2.'

EVENTS2="$(d1_json 'SELECT generation,owner_token,acquisition_id,event_type,event_at_ms,detail FROM publication_lease_events ORDER BY id;')"
printf '%s\n' "$EVENTS2" | json_assert \
  "rows.length === 2 && rows[0].generation == 1 && rows[0].acquisition_id === '$PROBE_ACQ_1' && rows[0].event_type === 'acquired' && rows[1].generation == 2 && rows[1].owner_token === '$PROBE_OWNER_2' && rows[1].acquisition_id === '$PROBE_ACQ_2' && rows[1].event_type === 'acquired' && rows[1].event_at_ms == $T_EXPIRY && rows[1].detail === 'expired-lease-takeover'" || \
  fail 'Exact-expiry takeover audit evidence is incorrect.'

OLD_RELEASE="$(d1_json "UPDATE publication_leases SET owner_token=NULL, acquisition_id=NULL, expires_at_ms=$T_RELEASE, updated_at_ms=$T_RELEASE WHERE lease_name='publisher' AND owner_token='$PROBE_OWNER_1' AND acquisition_id='$PROBE_ACQ_1' AND generation=1;")"
printf 'Fenced old-handle release metadata:\n%s\n' "$OLD_RELEASE"

ROW_OLD_RELEASE="$(d1_json 'SELECT * FROM publication_leases WHERE lease_name="publisher";')"
printf '%s\n' "$ROW_OLD_RELEASE" | json_assert \
  "rows.length === 1 && rows[0].owner_token === '$PROBE_OWNER_2' && rows[0].acquisition_id === '$PROBE_ACQ_2' && Number(rows[0].generation) === 2" || \
  fail 'Fenced generation-1 handle altered generation 2.'

EVENTS_OLD_RELEASE="$(d1_json 'SELECT generation,owner_token,acquisition_id,event_type,event_at_ms,detail FROM publication_lease_events ORDER BY id;')"
printf '%s\n' "$EVENTS_OLD_RELEASE" | json_assert \
  'rows.length === 2 && rows.every(r => r.event_type === "acquired")' || \
  fail 'Fenced old handle created release audit evidence.'

NEW_RELEASE="$(d1_json "UPDATE publication_leases SET owner_token=NULL, acquisition_id=NULL, expires_at_ms=$T_RELEASE, updated_at_ms=$T_RELEASE WHERE lease_name='publisher' AND owner_token='$PROBE_OWNER_2' AND acquisition_id='$PROBE_ACQ_2' AND generation=2;")"
printf 'Current-owner release D1 metadata:\n%s\n' "$NEW_RELEASE"

RELEASED="$(d1_json 'SELECT * FROM publication_leases WHERE lease_name="publisher";')"
printf '%s\n' "$RELEASED" | json_assert \
  'rows.length === 1 && rows[0].owner_token === null && rows[0].acquisition_id === null && Number(rows[0].generation) === 2' || \
  fail 'Released row did not preserve generation fencing evidence.'

EVENTS="$(d1_json 'SELECT generation,owner_token,acquisition_id,event_type,event_at_ms,detail FROM publication_lease_events ORDER BY id;')"
printf '%s\n' "$EVENTS" | json_assert \
  "rows.length === 3 && rows[0].generation == 1 && rows[0].acquisition_id === '$PROBE_ACQ_1' && rows[0].event_type === 'acquired' && rows[0].detail === 'initial-acquisition' && rows[1].generation == 2 && rows[1].acquisition_id === '$PROBE_ACQ_2' && rows[1].event_type === 'acquired' && rows[1].detail === 'expired-lease-takeover' && rows[2].generation == 2 && rows[2].owner_token === '$PROBE_OWNER_2' && rows[2].acquisition_id === '$PROBE_ACQ_2' && rows[2].event_type === 'released' && rows[2].event_at_ms == $T_RELEASE && rows[2].detail === 'owner-release'" || \
  fail 'Lease audit trail is not exactly acquire / takeover / release.'

printf '\n=== CLEANUP OWNED PREVIEW PROBE ===\n'
cleanup_probe
trap - EXIT

FINAL_LEASE="$(d1_json 'SELECT COUNT(*) AS count FROM publication_leases;')"
printf '%s\n' "$FINAL_LEASE" | json_assert 'Number(rows[0]?.count) === 0' || fail 'Preview lease cleanup was incomplete.'
FINAL_EVENTS="$(d1_json 'SELECT COUNT(*) AS count FROM publication_lease_events;')"
printf '%s\n' "$FINAL_EVENTS" | json_assert 'Number(rows[0]?.count) === 0' || fail 'Preview event cleanup was incomplete.'

printf '\n============================================================\n'
printf 'XQUEUE PREVIEW LEASE REHEARSAL: PASS\n'
printf 'Candidate: %s\n' "$LOCAL_SHA"
printf 'Migration: 0003_publication_lease.sql\n'
printf 'Target: preview D1 only\n'
printf 'Production authority: unchanged (local systemd)\n'
printf '============================================================\n'
