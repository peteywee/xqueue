#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
SERVICE_SRC="$ROOT/deploy/systemd/xqueue.service"
TIMER_SRC="$ROOT/deploy/systemd/xqueue.timer"

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

if ! bash "$ROOT/scripts/production-preflight.sh"; then
  echo 'ERROR: production preflight failed; scheduler was not installed.' >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
install -m 0644 "$SERVICE_SRC" "$UNIT_DIR/xqueue.service"
install -m 0644 "$TIMER_SRC" "$UNIT_DIR/xqueue.timer"

systemctl --user daemon-reload
systemctl --user enable --now xqueue.timer

printf '\n=== INSTALLED UNIT ===\n'
systemctl --user cat xqueue.service
printf '\n=== TIMER ===\n'
systemctl --user list-timers xqueue.timer --all --no-pager

cat <<'EOF'

XQUEUE SYSTEMD INSTALL: PASS

The timer is enabled. This installer did not invoke xqueue.service directly and
did not publish a post. The next timer firing will run the normal fail-closed
`pnpm post:live` eligibility check.
EOF
