#!/usr/bin/env bash
# Deploys the AgentFlow escrow contract to Stellar TESTNET.
#
# Keys are created with `stellar keys generate --secure-store`, so secrets live
# in the OS keyring, not in files. Accounts are funded by Friendbot (test XLM).
# Writes deployments/testnet.json and prints the API configuration to use.
#
# Usage: bash scripts/deploy-testnet.sh            (REVIEW_WINDOW defaults to 600s)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NETWORK=testnet
REVIEW_WINDOW="${REVIEW_WINDOW:-600}"

ensure_key() {
  if ! stellar keys address "$1" >/dev/null 2>&1; then
    stellar keys generate "$1" --secure-store >/dev/null
  fi
  stellar keys address "$1"
}

DEPLOYER=$(ensure_key agentflow-deployer)
ARBITER=$(ensure_key agentflow-arbiter)
SEP10=$(ensure_key agentflow-sep10) # signs auth challenges only; never funded
echo "deployer: $DEPLOYER"
echo "arbiter:  $ARBITER"

stellar keys fund agentflow-deployer --network "$NETWORK" >/dev/null
stellar keys fund agentflow-arbiter --network "$NETWORK" >/dev/null

XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "native XLM asset contract: $XLM_SAC"

(cd contracts && stellar contract build >/dev/null)
WASM=contracts/target/wasm32v1-none/release/agentflow_escrow.wasm
WASM_HASH=$(sha256sum "$WASM" | cut -d' ' -f1)

CONTRACT=$(stellar contract deploy --wasm "$WASM" --source agentflow-deployer --network "$NETWORK" \
  -- --admin "$DEPLOYER" --arbiter "$ARBITER" --review_window "$REVIEW_WINDOW" --tokens "[\"$XLM_SAC\"]")
echo "escrow contract: $CONTRACT"

# Read the configuration back from the chain to confirm the deployment.
stellar contract invoke --id "$CONTRACT" --source agentflow-deployer --network "$NETWORK" --send no -- get_config

cat > deployments/testnet.json <<JSON
{
  "network": "testnet",
  "contractId": "$CONTRACT",
  "wasmSha256": "$WASM_HASH",
  "admin": "$DEPLOYER",
  "arbiter": "$ARBITER",
  "reviewWindowSeconds": $REVIEW_WINDOW,
  "assets": [{ "code": "XLM", "contractId": "$XLM_SAC", "decimals": 7 }],
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

cat <<ENV

Add to .env (the SEP-10 secret is read from the OS keyring by alias):
ESCROW_CONTRACT_ID=$CONTRACT
ARBITER_ADDRESS=$ARBITER
ASSETS=[{"code":"XLM","contractId":"$XLM_SAC","decimals":7}]
SEP10_SERVER_SECRET_STELLAR_KEY=agentflow-sep10
ENV
