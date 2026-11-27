#!/usr/bin/env bash
# Verifies AgentFlow's testnet deployment and its recorded end-to-end run
# against the live network. Read-only: it needs no keys, no funds, no .env, no
# database and no running services.
#
# Checks:
#   1. The WASM deployed at the escrow address has the SHA-256 recorded in
#      deployments/testnet.json.
#   2. The contract's on-chain configuration (admin, arbiter, review window,
#      token allowlist) matches deployments/testnet.json.
#   3. Every transaction in the recorded E2E evidence exists on testnet with
#      the recorded outcome (the forged refund must have FAILED; every other
#      transaction must have succeeded).
#   4. With --rebuild: building contracts/ with the Rust and Stellar CLI
#      versions recorded in the deployed WASM reproduces the same SHA-256.
#
# Requirements: bash, curl, node (>= 18), sha256sum and the Stellar CLI. For
# --rebuild also rustup, with the toolchain named in the output installed
# (`rustup toolchain install <version> --target wasm32v1-none`).
#
# Usage:
#   bash scripts/verify-testnet.sh                 # checks 1-3
#   bash scripts/verify-testnet.sh --rebuild       # checks 1-4
#   bash scripts/verify-testnet.sh --receipt out.json
#
# Exit code 0 only if every check passed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REBUILD=0
RECEIPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) REBUILD=1 ;;
    --receipt) RECEIPT="${2:?--receipt needs a path}"; shift ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

DEPLOYMENT=deployments/testnet.json
EVIDENCE="${EVIDENCE:-$(ls deployments/e2e-testnet-*.json | sort | tail -1)}"
HORIZON="${HORIZON_URL:-https://horizon-testnet.stellar.org}"
export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

for tool in curl node sha256sum stellar; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

json() { node -e 'const d=require(process.argv[1]); const v=eval("d"+process.argv[2]); process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))' "$ROOT/$1" "$2"; }

CONTRACT=$(json "$DEPLOYMENT" .contractId)
EXPECTED_SHA=$(json "$DEPLOYMENT" .wasmSha256)
ADMIN=$(json "$DEPLOYMENT" .admin)
ARBITER=$(json "$DEPLOYMENT" .arbiter)
WINDOW=$(json "$DEPLOYMENT" .reviewWindowSeconds)
TOKEN=$(json "$DEPLOYMENT" '.assets[0].contractId')

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
FAILURES=0
declare -a RESULTS=()

if [ -t 1 ]; then G=$'\033[32m' R=$'\033[31m' N=$'\033[0m'; else G="" R="" N=""; fi
pass() { printf '  %sPASS%s %s\n' "$G" "$N" "$1"; RESULTS+=("{\"check\":$(node -p 'JSON.stringify(process.argv[1])' "$1"),\"ok\":true}"); }
fail() { printf '  %sFAIL%s %s\n' "$R" "$N" "$1"; RESULTS+=("{\"check\":$(node -p 'JSON.stringify(process.argv[1])' "$1"),\"ok\":false}"); FAILURES=$((FAILURES + 1)); }

echo "AgentFlow testnet verification"
echo "  contract: $CONTRACT"
echo "  evidence: $EVIDENCE"
echo

# 1. Deployed bytes ---------------------------------------------------------
echo "1. Deployed WASM"
if stellar contract fetch --id "$CONTRACT" -o "$WORK/deployed.wasm" 2>"$WORK/fetch.err"; then
  ACTUAL_SHA=$(sha256sum "$WORK/deployed.wasm" | cut -d' ' -f1)
  SIZE=$(wc -c < "$WORK/deployed.wasm" | tr -d ' ')
  if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
    pass "deployed sha256 $ACTUAL_SHA ($SIZE bytes) matches $DEPLOYMENT"
  else
    fail "deployed sha256 $ACTUAL_SHA does not match $DEPLOYMENT ($EXPECTED_SHA)"
  fi
  META=$(stellar contract info meta --wasm "$WORK/deployed.wasm" 2>/dev/null || true)
  RSVER=$(printf '%s\n' "$META" | sed -n 's/.*rsver: \([0-9.]*\).*/\1/p' | head -1)
  CLIVER=$(printf '%s\n' "$META" | sed -n 's/.*cliver: \([0-9.]*\).*/\1/p' | head -1)
  SDKVER=$(printf '%s\n' "$META" | sed -n 's/.*rssdkver: \([0-9.]*\).*/\1/p' | head -1)
  echo "       built with rustc $RSVER, soroban-sdk $SDKVER, stellar-cli $CLIVER (from the WASM's metadata)"
else
  fail "could not fetch the contract's WASM from testnet: $(tail -1 "$WORK/fetch.err")"
  echo "       Testnet is reset from time to time; if the contract is gone, the deployment must be redone."
fi
echo

# 2. On-chain configuration ---------------------------------------------------
echo "2. On-chain configuration"
# Simulation only (--send no): the admin's public address is the source
# account, no secret key is used and nothing is submitted.
read_view() { stellar contract invoke --id "$CONTRACT" --source-account "$ADMIN" --send no -- "$@" 2>"$WORK/invoke.err"; }
if CONFIG=$(read_view get_config); then
  node -e '
    const [c, admin, arbiter, win] = [JSON.parse(process.argv[1]), ...process.argv.slice(2)];
    process.exit(c.admin === admin && c.arbiter === arbiter && String(c.review_window) === win ? 0 : 1);
  ' "$CONFIG" "$ADMIN" "$ARBITER" "$WINDOW" \
    && pass "get_config: admin, arbiter and review window ($WINDOW s) match $DEPLOYMENT" \
    || fail "get_config returned $CONFIG, which does not match $DEPLOYMENT"
else
  fail "get_config simulation failed: $(tail -1 "$WORK/invoke.err")"
fi
if [ "$(read_view is_token_allowed --token "$TOKEN" || true)" = "true" ]; then
  pass "is_token_allowed: the XLM asset contract $TOKEN is allowed"
else
  fail "is_token_allowed did not return true for $TOKEN"
fi
echo

# 3. Recorded E2E transactions ------------------------------------------------
echo "3. Transactions recorded in $(basename "$EVIDENCE")"
# Lines of: <hash> <expected: SUCCESS|FAILED> <step description>
node -e '
  const steps = require(process.argv[1]).steps;
  for (const s of steps) {
    const d = s.detail || {};
    for (const key of ["tx", "assignTx", "rejectTx"]) {
      if (d[key]) console.log(d[key], d.result === "FAILED" && key === "tx" ? "FAILED" : "SUCCESS", s.step);
    }
  }
' "$ROOT/$EVIDENCE" > "$WORK/txs"
while read -r HASH EXPECT STEP; do
  BODY=$(curl -sS --max-time 20 "$HORIZON/transactions/$HASH" || true)
  OK=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const t=JSON.parse(s);process.stdout.write(t.hash?String(t.successful):"missing")}catch{process.stdout.write("missing")}})')
  SHORT="${HASH:0:12}…"
  if [ "$OK" = "missing" ]; then
    fail "$SHORT not found on testnet ($STEP)"
  elif { [ "$EXPECT" = SUCCESS ] && [ "$OK" = true ]; } || { [ "$EXPECT" = FAILED ] && [ "$OK" = false ]; }; then
    pass "$SHORT $( [ "$EXPECT" = FAILED ] && echo 'failed on-chain, as recorded' || echo 'succeeded') — $STEP"
  else
    fail "$SHORT expected $EXPECT, network says successful=$OK — $STEP"
  fi
done < "$WORK/txs"
echo

# 4. Reproducible build ---------------------------------------------------------
if [ "$REBUILD" = 1 ]; then
  echo "4. Reproducible build"
  RSVER="${RSVER:-1.96.0}"
  HAVE_CLI=$(stellar --version | head -1 | awk '{print $2}')
  if [ -n "${CLIVER:-}" ] && [ "$HAVE_CLI" != "$CLIVER" ]; then
    fail "stellar-cli $HAVE_CLI installed, but the deployment was built with $CLIVER; install $CLIVER to reproduce it"
  elif ! rustup run "$RSVER" rustc --version >/dev/null 2>&1; then
    fail "Rust $RSVER is not installed: rustup toolchain install $RSVER --target wasm32v1-none"
  else
    (cd contracts && RUSTUP_TOOLCHAIN="$RSVER" stellar contract build --locked >"$WORK/build.log" 2>&1) \
      || { tail -20 "$WORK/build.log"; }
    BUILT=contracts/target/wasm32v1-none/release/agentflow_escrow.wasm
    BUILT_SHA=$(sha256sum "$BUILT" 2>/dev/null | cut -d' ' -f1 || true)
    if [ "$BUILT_SHA" = "$EXPECTED_SHA" ]; then
      pass "rustc $RSVER + stellar-cli $HAVE_CLI build of $(git rev-parse --short HEAD) reproduces $BUILT_SHA"
    else
      fail "local build gives ${BUILT_SHA:-nothing}, expected $EXPECTED_SHA"
    fi
  fi
  echo
fi

if [ -n "$RECEIPT" ]; then
  mkdir -p "$(dirname "$RECEIPT")"
  printf '{"network":"testnet","contractId":"%s","wasmSha256":"%s","evidence":"%s","commit":"%s","checkedAt":"%s","passed":%s,"checks":[%s]}\n' \
    "$CONTRACT" "$EXPECTED_SHA" "$EVIDENCE" "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$([ "$FAILURES" = 0 ] && echo true || echo false)" "$(IFS=,; echo "${RESULTS[*]}")" \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.stringify(JSON.parse(s),null,2)))' > "$RECEIPT"
  echo "receipt written to $RECEIPT"
fi

if [ "$FAILURES" = 0 ]; then
  echo "All checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
