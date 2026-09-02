#!/usr/bin/env bash
set -Eeuo pipefail

: "${XQUEUE_NODE:?XQUEUE_NODE is required}"
: "${XQUEUE_COREPACK:?XQUEUE_COREPACK is required}"

if [[ "$XQUEUE_NODE" != /* || ! -x "$XQUEUE_NODE" ]]; then
  echo "ERROR: XQUEUE_NODE must be an absolute executable path: $XQUEUE_NODE" >&2
  exit 1
fi

if [[ "$XQUEUE_COREPACK" != /* || ! -x "$XQUEUE_COREPACK" ]]; then
  echo "ERROR: XQUEUE_COREPACK must be an absolute executable path: $XQUEUE_COREPACK" >&2
  exit 1
fi

NODE_DIR="$(dirname "$XQUEUE_NODE")"
case ":${PATH:-}:" in
  *":$NODE_DIR:"*) ;;
  *)
    echo "ERROR: PATH does not contain the pinned Node directory: $NODE_DIR" >&2
    exit 1
    ;;
esac

NODE_VERSION="$("$XQUEUE_NODE" --version)"
if ! "$XQUEUE_NODE" -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>22||(M===22&&m>=13)?0:1)'; then
  echo "ERROR: pinned Node runtime $NODE_VERSION is below required >=22.13" >&2
  exit 1
fi

PNPM_VERSION="$("$XQUEUE_COREPACK" pnpm --version)"

printf 'XQueue pinned systemd runtime: Node %s, pnpm %s\n' "$NODE_VERSION" "$PNPM_VERSION"
