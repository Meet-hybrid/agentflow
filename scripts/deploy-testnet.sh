#!/usr/bin/env bash
# Deploys the AgentFlow escrow contract to Stellar TESTNET.
#
# The deployer and arbiter keys are created with `stellar keys generate
# --secure-store`, so they live in the OS keyring and only the Stellar CLI signs
# with them. The SEP-10 key (signs auth challenges, holds no funds) must be
# readable by the API, so it is written to ~/.config/agentflow/sep10.secret
# with mode 600, outside the repository. Accounts are funded by Friendbot.
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
SEP10_FILE="${SEP10_FILE:-$HOME/.config/agentflow/sep10.secret}"
if [ ! -f "$SEP10_FILE" ]; then
  mkdir -p "$(dirname "$SEP10_FILE")" && chmod 700 "$(dirname "$SEP10_FILE")"
  (umask 077 && cd packages/stellar && node -e \
    'import("@stellar/stellar-sdk").then(s => process.stdout.write(s.Keypair.random().secret()))' > "$SEP10_FILE")
fi
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

Add to .env:
ESCROW_CONTRACT_ID=$CONTRACT
ARBITER_ADDRESS=$ARBITER
ASSETS=[{"code":"XLM","contractId":"$XLM_SAC","decimals":7}]
SEP10_SERVER_SECRET_FILE=$SEP10_FILE
ENV
