#!/usr/bin/env bash
# Ship the engine and relayer to the box: copy the source, build there, restart, check /health.
#
#   infra/deploy.sh           # code only
#   infra/deploy.sh --env     # also replace /etc/skech/env with the server's keys from .env.local
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${SKECH_HOST:-skech}"

# Only what the engine and relayer read. .env.local holds much more (CDP, Lighter, the database);
# none of it goes to the box.
SERVER_KEYS="SKECH_NETWORK ENGINE_PRIVATE_KEY ENGINE_BAND_BPS ENGINE_SENTRY_DSN RELAYER_PRIVATE_KEY RELAYER_SHADOW_EVERY
  RELAYER_SENTRY_DSN MONAD_RPC_URL MONAD_TESTNET_RPC_URL MONAD_MAINNET_RPC_URL
  SKECH_SOLANA_CLUSTER SOLANA_RELAYER_SECRET_KEY SOLANA_DEVNET_RPC_URL SOLANA_DEVNET_WS_URL SOLANA_MAINNET_BETA_RPC_URL
  SOLANA_MAINNET_BETA_WS_URL SOLANA_PRIORITY_MICROLAMPORTS SOLANA_PRIORITY_MAX_MICROLAMPORTS"

if [ "${1:-}" = "--env" ]; then
  [ -f .env.local ] || { echo ".env.local not found" >&2; exit 1; }
  for k in $SERVER_KEYS; do grep -E "^$k=.+" .env.local || true; done \
    | ssh "$HOST" 'sudo tee /etc/skech/env >/dev/null && sudo chown root:skech /etc/skech/env && sudo chmod 640 /etc/skech/env'
  echo "env: $(ssh "$HOST" 'sudo cut -d= -f1 /etc/skech/env | tr "\n" " "')"
  # The Solana relayer runs only on a box with a Solana cluster and key.
  if ssh "$HOST" 'sudo grep -q "^SOLANA_RELAYER_SECRET_KEY=" /etc/skech/env && sudo grep -q "^SKECH_SOLANA_CLUSTER=" /etc/skech/env'; then
    ssh "$HOST" 'sudo touch /etc/skech/solana'
  else
    ssh "$HOST" 'sudo rm -f /etc/skech/solana'
  fi
fi

# The workspace skeleton (ui/*/package.json keeps bun.lock's graph whole), core, relayer,
# the engine's source, and the contracts' deployments, ABIs and gas snapshot. Nothing excluded
# is deleted on the box, so node_modules, target/ and the relayer's state survive.
rsync -az --delete --rsync-path="sudo -u skech rsync" \
  --exclude='node_modules/' --exclude='.relayer-state*' --exclude='.relayer-activity*' --exclude='*.tsbuildinfo' --exclude='dist/' --exclude='*.test.ts' \
  --include='/package.json' --include='/bun.lock' --include='/bunfig.toml' --include='/tsconfig.base.json' \
  --include='/ui/' --include='/ui/*/' --include='/ui/*/package.json' \
  --include='/packages/' --include='/packages/core/***' --include='/packages/relayer/***' \
  --include='/packages/engine/' --include='/packages/engine/Cargo.*' --include='/packages/engine/package.json' --include='/packages/engine/src/***' \
  --include='/packages/contracts/' --include='/packages/contracts/package.json' --include='/packages/contracts/deployments/***' \
  --include='/packages/contracts/evm/' --include='/packages/contracts/evm/abi/***' --include='/packages/contracts/evm/snapshots/***' \
  --include='/packages/contracts/solana/' --include='/packages/contracts/solana/sdk.ts' --include='/packages/contracts/solana/client/***' --include='/packages/contracts/solana/snapshots/***' \
  --exclude='*' \
  ./ "$HOST:/opt/skech/"

# The commit being shipped, built into the engine as its Sentry release. The box has no .git: rsync
# copies the working tree, so uncommitted changes are marked.
RELEASE="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- packages/engine || echo -dirty)"

# The services and Caddy's routes too, so a new one (the Solana relayer's) needs no setup.sh rerun.
scp -q infra/Caddyfile infra/systemd/*.service "$HOST:/tmp/"

ssh "$HOST" "SKECH_RELEASE=$RELEASE bash -s" <<'REMOTE'
set -euo pipefail
sudo -u skech -H SKECH_RELEASE="$SKECH_RELEASE" bash -euc '
  export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
  cd /opt/skech
  bun install --production --frozen-lockfile --filter @skech/relayer
  cd packages/engine && cargo build --release -q
'
sudo install -m 644 /tmp/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo install -m 644 /tmp/Caddyfile /etc/caddy/Caddyfile && (sudo systemctl reload caddy || true)
sudo systemctl restart skech-engine skech-relayer
if [ -f /etc/skech/solana ]; then sudo systemctl enable -q skech-relayer-solana; sudo systemctl restart skech-relayer-solana; fi
for i in $(seq 20); do
  e=$(curl -fs localhost:3102/health || true); r=$(curl -fs localhost:3103/health || true)
  [ "$e" = ok ] && [ "$r" = ok ] && break
  sleep 1
done
echo "engine: ${e:-down}  relayer: ${r:-down}"
[ "$e" = ok ] && [ "$r" = ok ] || { sudo journalctl -u skech-engine -u skech-relayer -n 30 --no-pager; exit 1; }
REMOTE
