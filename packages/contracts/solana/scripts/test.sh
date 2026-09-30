#!/usr/bin/env bash
# anchor test, on a local validator started away from port 8000 (Docker's), stopped afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
ledger="$(mktemp -d)"
solana-test-validator --ledger "$ledger" --reset --quiet --gossip-port 8110 --dynamic-port-range 8111-8140 >/dev/null 2>&1 &
validator=$!
trap 'kill $validator 2>/dev/null; rm -rf "$ledger"' EXIT
for _ in $(seq 1 60); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done
# A program deployed this slot is only loadable from the next, so deploy, wait, then test.
anchor build
anchor deploy --provider.cluster localnet
sleep 2
anchor test --skip-local-validator --skip-build --skip-deploy
