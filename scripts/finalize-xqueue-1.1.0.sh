#!/usr/bin/env bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

REPO="peteywee/xqueue"
EXPECTED_VERSION="1.1.0"
HEALTH_URL="https://xqueue-production.patrickcraven.workers.dev/health"
AUTHORITY_CONFIG="wrangler.authority.jsonc"
MAX_HEARTBEAT_CHECKS=60
HEARTBEAT_SLEEP_SECONDS=20

fail() {
  printf '\nXQUEUE 1.1.0 FINALIZATION: FAIL\n%s\n' "$*" >&2
  exit 1
}

printf '%s\n' '============================================================'
printf '%s\n' ' XQUEUE 1.1.0 — FINAL PRODUCTION PROOF + FREEZE'
printf '%s\n' '============================================================'
printf '%s\n' 'This performs one explicit production-authority deployment.'
printf '%s\n' 'It will not publish content directly or catch up missed work.'

command -v git >/dev/null 2>&1 || fail 'git is required.'
command -v pnpm >/dev/null 2>&1 || fail 'pnpm is required.'
command -v gh >/dev/null 2>&1 || fail 'gh is required.'
command -v curl >/dev/null 2>&1 || fail 'curl is required.'
command -v node >/dev/null 2>&1 || fail 'Node.js is required.'

[[ "$(git branch --show-current)" == "main" ]] || fail 'Run this from the main branch.'

git fetch --quiet origin main || fail 'Could not fetch origin/main.'
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"
[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] || fail "Local main $LOCAL_SHA is not exact origin/main $REMOTE_SHA. Pull first."

git diff --quiet || fail 'Tracked working-tree changes are present.'
git diff --cached --quiet || fail 'Staged changes are present.'

VERSION="$(tr -d '[:space:]' < VERSION)"
PACKAGE_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
[[ "$VERSION" == "$EXPECTED_VERSION" ]] || fail "VERSION is $VERSION, expected $EXPECTED_VERSION."
[[ "$PACKAGE_VERSION" == "$EXPECTED_VERSION" ]] || fail "package.json is $PACKAGE_VERSION, expected $EXPECTED_VERSION."

printf '\n=== EXACT CANDIDATE ===\n'
printf 'version: %s\nsha:     %s\n' "$VERSION" "$LOCAL_SHA"

printf '\n=== LOCAL/REPOSITORY VERIFY ===\n'
pnpm verify || fail 'pnpm verify failed; production was not deployed.'

DEPLOY_STARTED_MS="$(node -p 'Date.now()')"
printf '\n=== EXPLICIT PRODUCTION AUTHORITY DEPLOY ===\n'
pnpm wrangler deploy --config "$AUTHORITY_CONFIG" || fail 'Explicit authority deployment failed.'

printf '\n=== WAIT FOR A REAL POST-DEPLOY SCHEDULED INVOCATION ===\n'
HEARTBEAT_OK=0
for ((i=1; i<=MAX_HEARTBEAT_CHECKS; i++)); do
  BODY="$(curl -sS --max-time 10 "$HEALTH_URL" 2>/dev/null || true)"
  if printf '%s' "$BODY" | node -e '
    const fs = require("node:fs");
    const start = Number(process.argv[1]);
    let body;
    try { body = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
    const last = Date.parse(body?.schedulerLiveness?.lastInvocationAt ?? "");
    const ok = body?.schedulerLiveness?.ok === true && Number.isFinite(last) && last >= start;
    if (ok) {
      console.log(JSON.stringify({
        status: body.status,
        schedulerAuthority: body.schedulerAuthority,
        lastInvocationAt: body.schedulerLiveness.lastInvocationAt,
        expectedNextAt: body.schedulerLiveness.expectedNextAt,
        staleAfterAt: body.schedulerLiveness.staleAfterAt
      }, null, 2));
      process.exit(0);
    }
    process.exit(1);
  ' "$DEPLOY_STARTED_MS"; then
    HEARTBEAT_OK=1
    break
  fi

  printf 'heartbeat not yet post-deploy (%d/%d)\n' "$i" "$MAX_HEARTBEAT_CHECKS"
  sleep "$HEARTBEAT_SLEEP_SECONDS"
done

[[ "$HEARTBEAT_OK" == "1" ]] || fail 'No fresh post-deploy scheduled heartbeat was observed within 20 minutes.'

printf '\n=== FRESH TSAL CONFORMANCE ===\n'
TRIGGERED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run tsal-conformance.yml --repo "$REPO" --ref main || fail 'Could not dispatch TSAL Conformance.'
sleep 4

RUN_JSON="$(gh run list \
  --repo "$REPO" \
  --workflow tsal-conformance.yml \
  --event workflow_dispatch \
  --branch main \
  --limit 10 \
  --json databaseId,headSha,createdAt,status,conclusion,url)" || fail 'Could not list TSAL runs.'

RUN_ID="$(printf '%s' "$RUN_JSON" | node -e '
  const fs = require("node:fs");
  const runs = JSON.parse(fs.readFileSync(0, "utf8"));
  const sha = process.argv[1];
  const after = Date.parse(process.argv[2]) - 5000;
  const run = runs.find(r => r.headSha === sha && Date.parse(r.createdAt) >= after);
  if (!run) process.exit(1);
  process.stdout.write(String(run.databaseId));
' "$LOCAL_SHA" "$TRIGGERED_AT")" || fail 'Could not resolve the newly dispatched exact-SHA TSAL run.'

printf 'TSAL run: %s\n' "$RUN_ID"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status || fail "TSAL Conformance run $RUN_ID failed."

FINAL_RUN="$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion,headSha,url)" || fail 'Could not read final TSAL run.'
printf '%s\n' "$FINAL_RUN"
printf '%s' "$FINAL_RUN" | node -e '
  const fs = require("node:fs");
  const run = JSON.parse(fs.readFileSync(0, "utf8"));
  const expected = process.argv[1];
  if (run.headSha !== expected || run.conclusion !== "success") process.exit(1);
' "$LOCAL_SHA" || fail 'TSAL did not prove the exact release SHA.'

printf '\n=== IMMUTABLE RELEASE TAG ===\n'
REMOTE_TAG="$(git ls-remote --tags origin refs/tags/1.1.0 | awk '{print $1}')"
if [[ -n "$REMOTE_TAG" ]]; then
  TAG_SHA="$(git rev-list -n 1 1.1.0 2>/dev/null || true)"
  [[ "$TAG_SHA" == "$LOCAL_SHA" ]] || fail 'Remote/local 1.1.0 tag exists but does not resolve to the proven candidate.'
  printf 'tag 1.1.0 already resolves to %s\n' "$TAG_SHA"
else
  git tag -a 1.1.0 "$LOCAL_SHA" -m 'XQueue 1.1.0 — final reliability closeout' || fail 'Could not create 1.1.0 tag.'
  git push origin refs/tags/1.1.0 || fail 'Could not push 1.1.0 tag.'
fi

printf '\n============================================================\n'
printf ' XQUEUE 1.1.0: PROVEN — FREEZE READY\n'
printf ' SHA: %s\n' "$LOCAL_SHA"
printf ' TSAL run: %s\n' "$RUN_ID"
printf '============================================================\n'
