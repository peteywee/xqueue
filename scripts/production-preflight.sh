#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILURES=0
WARNINGS=0

pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; WARNINGS=$((WARNINGS + 1)); }
fail() { printf 'FAIL  %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
section() { printf '\n=== %s ===\n' "$*"; }

run_gate() {
  local label="$1"
  shift
  printf '\n--- %s ---\n' "$label"
  if "$@"; then
    pass "$label"
  else
    fail "$label"
  fi
}

section 'IDENTITY'
printf 'repo: %s\n' "$ROOT"
printf 'host: %s\n' "$(hostname)"
printf 'user: %s\n' "$(id -un)"
printf 'time: %s\n' "$(date --iso-8601=seconds 2>/dev/null || date)"

section 'RUNTIME'
for cmd in git node corepack pnpm; do
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "$cmd -> $(command -v "$cmd")"
  else
    fail "required command missing: $cmd"
  fi
done

if command -v node >/dev/null 2>&1; then
  printf 'node: %s\n' "$(node --version)"
  if node -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>22||(M===22&&m>=13)?0:1)'; then
    pass 'Node version satisfies >=22.13'
  else
    fail "Node $(node --version) is below the required >=22.13"
  fi
fi

if command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm: %s\n' "$(pnpm --version)"
fi

section 'GIT CANDIDATE'
branch="$(git branch --show-current 2>/dev/null || true)"
head="$(git rev-parse HEAD 2>/dev/null || true)"
origin_main="$(git rev-parse origin/main 2>/dev/null || true)"
printf 'branch: %s\n' "${branch:-DETACHED}"
printf 'HEAD: %s\n' "${head:-UNKNOWN}"
printf 'origin/main: %s\n' "${origin_main:-UNKNOWN}"

if [[ "$branch" == 'main' ]]; then
  pass 'production checkout is on main'
else
  fail "production checkout must be on main (current: ${branch:-DETACHED})"
fi

if git diff --quiet && git diff --cached --quiet; then
  pass 'no tracked worktree/index modifications'
else
  fail 'tracked local modifications exist; preserve/review them before production cutover'
  git status --short || true
fi

if [[ -n "$origin_main" && "$head" == "$origin_main" ]]; then
  pass 'HEAD matches the locally known origin/main'
elif [[ -n "$origin_main" ]]; then
  fail 'HEAD does not match the locally known origin/main; run git fetch and review before cutover'
else
  warn 'origin/main is unavailable locally; exact remote-head comparison skipped'
fi

if git ls-files --error-unmatch queue.json >/dev/null 2>&1; then
  fail 'queue.json is tracked; generated queue must remain untracked'
else
  pass 'queue.json is not tracked'
fi

section 'SECRETS AND STATE'
if [[ -f .env ]]; then
  pass '.env exists'
  mode="$(stat -c '%a' .env 2>/dev/null || true)"
  if [[ -n "$mode" ]]; then
    printf '.env mode: %s\n' "$mode"
    perm=$((8#$mode))
    if (( (perm & 0077) == 0 )); then
      pass '.env is not group/world accessible'
    else
      fail '.env permissions expose credentials beyond the owner; run chmod 600 .env'
    fi
  else
    warn 'could not inspect .env permissions'
  fi
else
  fail '.env is missing'
fi

if [[ -f state.json ]]; then
  if node --input-type=module -e "import { readState } from './src/state-store.mjs'; const s=readState('./state.json'); console.log(JSON.stringify({posted:Object.keys(s.posted).length,skipped:Object.keys(s.skipped).length,spend:s.spend,inflight:s.inflight},null,2));"; then
    pass 'state.json parses and satisfies the publication-ledger schema'
  else
    fail 'state.json is invalid; do not delete it or attempt live publication'
  fi
else
  warn 'state.json does not exist; this is safe only if this publisher has never successfully posted'
fi

section 'REPOSITORY GATES'
run_gate 'pnpm verify' pnpm verify
run_gate 'pnpm validate:production' pnpm validate:production
run_gate 'runtime backlog health' pnpm runtime:health
run_gate 'authenticated X identity (read-only)' node src/cli.mjs whoami

section 'QUEUE / MEDIA'
if [[ -f queue.json ]]; then
  pass 'generated queue.json exists'
else
  fail 'queue.json does not exist after verification'
fi

printf '\nmedia inventory:\n'
find media -maxdepth 1 -type f ! -name '.gitkeep' -print 2>/dev/null | sort || true

figure23="$(find media -maxdepth 1 -type f \
  \( -iname '23.png' -o -iname '23.jpg' -o -iname '23.jpeg' -o -iname '23.gif' -o -iname '23.webp' \
     -o -iname 'figure23.png' -o -iname 'figure23.jpg' -o -iname 'figure23.jpeg' -o -iname 'figure23.gif' -o -iname 'figure23.webp' \
     -o -iname 'figure-23.png' -o -iname 'figure-23.jpg' -o -iname 'figure-23.jpeg' -o -iname 'figure-23.gif' -o -iname 'figure-23.webp' \
     -o -iname 'figure_23.png' -o -iname 'figure_23.jpg' -o -iname 'figure_23.jpeg' -o -iname 'figure_23.gif' -o -iname 'figure_23.webp' \) \
  -print -quit 2>/dev/null || true)"

if [[ -n "$figure23" ]]; then
  pass "figure 23 present: $figure23"
else
  fail 'figure 23 is missing; the 2026-09-01 22:15 C1 post requires it'
fi

run_gate 'pnpm stats' pnpm stats
run_gate 'pnpm next (4)' node src/cli.mjs next 4
run_gate 'dry-run publication path (zero X mutations)' pnpm post:dry

section 'SCHEDULER AUDIT'
scheduler_found=0
scheduler_bad=0

cron_text="$(crontab -l 2>/dev/null || true)"
cron_xqueue="$(printf '%s\n' "$cron_text" | grep -Ev '^[[:space:]]*(#|$)' | grep -i 'xqueue' || true)"
if [[ -n "$cron_xqueue" ]]; then
  scheduler_found=1
  printf 'active xqueue cron entries:\n%s\n' "$cron_xqueue"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" == *'post:live'* || "$line" == *'post --live'* ]]; then
      pass 'cron xqueue entry uses explicit live publication'
    else
      fail "cron xqueue entry does not use explicit live publication: $line"
      scheduler_bad=1
    fi
  done <<< "$cron_xqueue"
fi

unit_text=''
if command -v systemctl >/dev/null 2>&1; then
  unit_text="$(systemctl --user cat xqueue.service 2>/dev/null || true)"
  if [[ -n "$unit_text" ]]; then
    scheduler_found=1
    printf '\nxqueue.service:\n%s\n' "$unit_text"
    if grep -Eq 'post:live|post[[:space:]]+--live' <<< "$unit_text"; then
      pass 'systemd xqueue.service uses explicit live publication'
    else
      fail 'systemd xqueue.service does not use explicit live publication'
      scheduler_bad=1
    fi

    printf '\nxqueue.timer status:\n'
    systemctl --user status xqueue.timer --no-pager 2>/dev/null || true
  fi
fi

if (( scheduler_found == 0 )); then
  warn 'no active xqueue cron entry or xqueue.service was detected'
elif (( scheduler_bad == 0 )); then
  pass 'detected scheduler configuration is live-enabled explicitly'
fi

section 'RESULT'
printf 'warnings: %d\n' "$WARNINGS"
printf 'failures: %d\n' "$FAILURES"

if (( FAILURES > 0 )); then
  printf '\nXQUEUE PRODUCTION PREFLIGHT: FAIL\n' >&2
  printf 'No live publication was attempted. Fix every FAIL before enabling the scheduler.\n' >&2
  exit 1
fi

printf '\nXQUEUE PRODUCTION PREFLIGHT: PASS\n'
printf 'No live publication was attempted. The host is ready for scheduler cutover.\n'
