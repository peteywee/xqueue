#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
RUNTIME_DIR="$HOME/.config/xqueue"
RUNTIME_ENV="$RUNTIME_DIR/runtime.env"
SERVICE_SRC="$ROOT/deploy/systemd/xqueue.service"
TIMER_SRC="$ROOT/deploy/systemd/xqueue.timer"
RUNTIME_CHECK="$ROOT/deploy/systemd/check-runtime.sh"

if ! command -v systemctl >/dev/null 2>&1; then
  echo 'ERROR: systemctl is not available on this host.' >&2
  exit 1
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo 'ERROR: the user systemd manager is not available.' >&2
  exit 1
fi

if [[ "$ROOT" != "$HOME/xqueue" ]]; then
  echo "ERROR: packaged units intentionally target %h/xqueue, but this checkout is $ROOT" >&2
  echo 'Move/clone the production checkout to ~/xqueue or edit and review the unit explicitly.' >&2
  exit 1
fi

cron_xqueue="$(crontab -l 2>/dev/null | grep -Ev '^[[:space:]]*(#|$)' | grep -i 'xqueue' || true)"
if [[ -n "$cron_xqueue" ]]; then
  echo 'ERROR: active xqueue cron entries already exist:' >&2
  echo "$cron_xqueue" >&2
  echo 'Refusing to install a second scheduler. Remove/disable the cron scheduler first.' >&2
  exit 1
fi

for cmd in node corepack pnpm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required runtime command is missing from the invoking shell: $cmd" >&2
    exit 1
  fi
done

NODE_BIN="$(command -v node)"
COREPACK_BIN="$(command -v corepack)"
NODE_DIR="$(dirname "$NODE_BIN")"
SERVICE_PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin"

if [[ "$NODE_BIN" != /* || "$COREPACK_BIN" != /* ]]; then
  echo 'ERROR: node and corepack must resolve to absolute executable paths.' >&2
  exit 1
fi

if ! node -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>22||(M===22&&m>=13)?0:1)'; then
  echo "ERROR: invoking Node $(node --version) is below the required >=22.13" >&2
  exit 1
fi

printf 'Selected systemd runtime:\n'
printf '  node:     %s (%s)\n' "$NODE_BIN" "$(node --version)"
printf '  corepack: %s\n' "$COREPACK_BIN"
printf '  PATH:     %s\n' "$SERVICE_PATH"

if ! env -i \
  HOME="$HOME" \
  PATH="$SERVICE_PATH" \
  XQUEUE_NODE="$NODE_BIN" \
  XQUEUE_COREPACK="$COREPACK_BIN" \
  /bin/bash "$RUNTIME_CHECK"; then
  echo 'ERROR: selected runtime does not work in an isolated systemd-like environment.' >&2
  exit 1
fi

# Contain any prior timer before replacing unit/runtime configuration. This
# never starts xqueue.service and therefore cannot publish a post.
systemctl --user disable --now xqueue.timer >/dev/null 2>&1 || true

# Do not replace files underneath an already-running publisher. If a prior
# service is active, leave the timer disabled and require the operator to
# inspect that execution before retrying installation.
if systemctl --user is-active --quiet xqueue.service; then
  echo 'ERROR: xqueue.service is currently active; timer is disabled and installation stopped.' >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/.local/state/xqueue/systemd-backups/$STAMP"
mkdir -p "$BACKUP_DIR"

for existing in \
  "$UNIT_DIR/xqueue.service" \
  "$UNIT_DIR/xqueue.timer" \
  "$RUNTIME_ENV"
do
  if [[ -f "$existing" ]]; then
    cp -a "$existing" "$BACKUP_DIR/"
  fi
done

mkdir -p "$UNIT_DIR" "$RUNTIME_DIR"
umask 077
RUNTIME_TMP="$(mktemp "$RUNTIME_DIR/runtime.env.tmp.XXXXXX")"
cat >"$RUNTIME_TMP" <<EOF
PATH=$SERVICE_PATH
XQUEUE_NODE=$NODE_BIN
XQUEUE_COREPACK=$COREPACK_BIN
EOF
install -m 0600 "$RUNTIME_TMP" "$RUNTIME_ENV"
rm -f "$RUNTIME_TMP"

install -m 0644 "$SERVICE_SRC" "$UNIT_DIR/xqueue.service"
install -m 0644 "$TIMER_SRC" "$UNIT_DIR/xqueue.timer"

systemctl --user daemon-reload
systemctl --user reset-failed xqueue.service >/dev/null 2>&1 || true

# Validate the exact staged scheduler while it is still disabled. A failed
# preflight leaves the new unit installed for inspection but cannot schedule
# or publish anything.
if ! bash "$ROOT/scripts/production-preflight.sh"; then
  echo 'ERROR: production preflight failed; xqueue.timer remains disabled.' >&2
  echo "Previous scheduler files, if any, were preserved at: $BACKUP_DIR" >&2
  exit 1
fi

systemctl --user enable --now xqueue.timer

printf '\n=== PINNED RUNTIME ===\n'
cat "$RUNTIME_ENV"
printf '\n=== INSTALLED UNIT ===\n'
systemctl --user cat xqueue.service
printf '\n=== TIMER ===\n'
systemctl --user list-timers xqueue.timer --all --no-pager

cat <<EOF

XQUEUE SYSTEMD INSTALL: PASS

The timer is enabled. The service is pinned to the Node/Corepack runtime that
passed the isolated runtime check above. This installer did not invoke
xqueue.service directly and did not publish a post. The next timer firing will
run the normal fail-closed \`pnpm post:live\` eligibility check.

Previous scheduler files, if any, were preserved at:
$BACKUP_DIR
EOF
