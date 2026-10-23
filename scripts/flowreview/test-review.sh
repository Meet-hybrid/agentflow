#!/usr/bin/env bash
# Regression tests for FlowReview. Builds a throwaway repository with one
# branch per rule and asserts the analyzer's findings, then checks the AI
# summary's sanitizing and failure handling against saved API responses (no
# network, no API key).
# Usage: bash scripts/flowreview/test-review.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
OUT="$(mktemp)"
trap 'rm -rf "$WORK" "$OUT"' EXIT

pass=0
failures=0
ok() { pass=$((pass + 1)); }
bad() {
  failures=$((failures + 1))
  printf 'FAIL: %s\n' "$1"
  sed 's/^/    /' "$OUT"
}

cd "$WORK"
git init -q -b main
git config user.email test@example.com
git config user.name test
mkdir -p crates/vault/src crates/tool/src
cat >crates/vault/Cargo.toml <<'EOF'
[package]
name = "vault"
[lib]
crate-type = ["cdylib"]
[dependencies]
soroban-sdk = "22"
EOF
cat >crates/vault/src/lib.rs <<'EOF'
pub fn withdraw(env: Env, owner: Address) {
    owner.require_auth();
    transfer(&env, &owner);
}
EOF
printf '[package]\nname = "tool"\n' >crates/tool/Cargo.toml
printf 'pub fn run() {}\n' >crates/tool/src/lib.rs
mkdir -p crates/tool/src/commands
printf 'pub fn build() {}\n' >crates/tool/src/commands/build.rs
printf '{"name":"sdk","dependencies":{"left-pad":"1.0.0"}}\n' >package.json
git add -A
git commit -qm base

# case NAME JQ_ASSERTION — apply the commands on stdin on a fresh branch, run
# the analyzer and assert the jq expression is true for its output.
case_() {
  local name=$1 assertion=$2
  git checkout -q -b "case-$pass-$failures" main
  bash -e
  git add -A
  git commit -qm "$name" --allow-empty
  if python3 "$ROOT/scripts/flowreview/analyze.py" main HEAD >"$OUT" 2>&1 \
    && jq -e "$assertion" "$OUT" >/dev/null; then
    ok
  else
    bad "$name"
  fi
  git checkout -q main
}

has() { printf '([.findings[] | select(.level == "%s" and (.message | contains("%s")))] | length > 0)' "$1" "$2"; }

case_ "docs-only change is low risk" '.risk == "low" and (.findings | length) == 0' <<'EOF'
printf '# Notes\n' >README.md
EOF

case_ "removed require_auth is high risk" "$(has high 'authorization check removed') and .risk == \"high\"" <<'EOF'
sed -i '/require_auth/d' crates/vault/src/lib.rs
EOF

case_ "contract change without tests is flagged" "$(has medium 'no tests were added')" <<'EOF'
printf 'pub fn extra() {}\n' >>crates/vault/src/lib.rs
EOF

case_ "inline #[test] counts as a test change" '.tests_changed and ([.findings[] | select(.message | contains("no tests"))] | length) == 0' <<'EOF'
printf '#[cfg(test)]\nmod t {\n    #[test]\n    fn x() { None::<u8>.unwrap(); }\n}\n' >>crates/vault/src/lib.rs
EOF

case_ "panics and unsafe in contract code are flagged" "$(has medium 'can panic') and $(has medium 'unsafe')" <<'EOF'
printf 'pub fn f(v: Option<u8>) -> u8 { unsafe { v.unwrap() } }\n' >>crates/vault/src/lib.rs
EOF

case_ "upgrade path is high risk" "$(has high 'upgrade path')" <<'EOF'
printf 'pub fn up(env: Env, h: BytesN<32>) { env.deployer().update_current_contract_wasm(h); }\n' >>crates/vault/src/lib.rs
EOF

case_ "crate-root build.rs is a build script" "$(has high 'Cargo build script')" <<'EOF'
printf 'fn main() {}\n' >crates/tool/build.rs
EOF

case_ "a module named build.rs is not a build script" '([.findings[] | select(.message | contains("build script"))] | length) == 0' <<'EOF'
printf 'pub fn build() { let _ = 1; }\n' >crates/tool/src/commands/build.rs
EOF

case_ "git dependency is high risk" "$(has high 'from a git source')" <<'EOF'
printf 'evil = { git = "https://example.com/evil" }\n' >>crates/vault/Cargo.toml
EOF

case_ "new crates.io dependency is medium" "$(has medium 'new dependency') and $(has medium 'serde')" <<'EOF'
printf 'serde = "1"\n' >>crates/vault/Cargo.toml
EOF

case_ "#[cfg(test)] module files are test code, not contract code" '.tests_changed and ([.findings[] | select(.message | contains("can panic"))] | length) == 0' <<'EOF'
printf '#[cfg(test)]\nmod fixtures;\n' >>crates/vault/src/lib.rs
printf 'pub fn f() { None::<u8>.unwrap(); }\n' >crates/vault/src/fixtures.rs
EOF

case_ "panics in one file are grouped into one finding" '([.findings[] | select(.message | contains("can panic"))] | length) == 1' <<'EOF'
printf 'pub fn a(v: Option<u8>) -> u8 { v.unwrap() }\npub fn b(v: Option<u8>) -> u8 { v.unwrap() }\n' >>crates/vault/src/lib.rs
EOF

case_ "dev-dependency is labelled as such" "$(has medium 'new dev-dependency')" <<'EOF'
printf '[dev-dependencies]\nproptest = "1"\n' >>crates/vault/Cargo.toml
EOF

case_ "in-repo path dependency is not high risk" '.risk == "medium" and ([.findings[] | select(.level == "high")] | length) == 0' <<'EOF'
printf 'tool = { path = "../tool" }\n' >>crates/vault/Cargo.toml
EOF

case_ "path dependency outside the repo is high risk" "$(has high 'outside this repository')" <<'EOF'
printf 'evil = { path = "../../../elsewhere" }\n' >>crates/vault/Cargo.toml
EOF

case_ "TypeScript test files count as tests" '[.files[] | select(.path == "sdk/x.test.ts" and .category == "tests")] | length == 1' <<'EOF'
mkdir -p sdk && printf 'test("x", () => {});\n' >sdk/x.test.ts
EOF

case_ "non-registry npm dependency is high risk" "$(has high 'non-registry source')" <<'EOF'
printf '{"name":"sdk","dependencies":{"left-pad":"1.0.0","x":"github:evil/x"}}\n' >package.json
EOF

case_ "workflow change is high risk" "$(has high 'repository automation')" <<'EOF'
mkdir -p .github/workflows && printf 'on: push\n' >.github/workflows/x.yml
EOF

case_ "large PR is flagged" "$(has medium 'large PRs')" <<'EOF'
seq 1 900 | sed 's/^/line /' >notes.txt
EOF

# ---------------------------------------------------------------------------
# AI summary: sanitizing and failure handling, from saved API responses.
# ---------------------------------------------------------------------------
printf '{"title":"t","body":"b","author":"a"}\n' >"$WORK/pr.json"
printf '{"risk":"low","findings":[]}\n' >"$WORK/analysis.json"
printf 'diff\n' >"$WORK/diff.patch"

summary_case() {
  local name=$1 response=$2 check=$3
  printf '%s' "$response" >"$WORK/response.json"
  if FLOWREVIEW_AI_RESPONSE="$WORK/response.json" \
    bash "$ROOT/scripts/flowreview/ai-summary.sh" "$WORK/pr.json" "$WORK/analysis.json" "$WORK/diff.patch" \
    >"$OUT" 2>/dev/null && bash -c "$check" _ "$OUT"; then
    ok
  else
    bad "$name"
  fi
}

summary_case "summary text is printed" \
  '{"stop_reason":"end_turn","content":[{"type":"text","text":"**What it does** adds a fee."}]}' \
  'grep -q "adds a fee" "$1"'

summary_case "mentions, images, links and HTML are neutralized" \
  '{"stop_reason":"end_turn","content":[{"type":"text","text":"ping @maintainer ![x](https://t.example/p.png) [click](https://evil.example) <!-- flowreview --> done"}]}' \
  '! grep -q "@maintainer" "$1" && ! grep -q "p.png" "$1" && ! grep -q "evil.example" "$1" && ! grep -q "<!--" "$1" && grep -q "click" "$1" && grep -q done "$1"'

summary_case "a refusal prints nothing" \
  '{"stop_reason":"refusal","stop_details":{"category":"cyber"},"content":[]}' \
  '! grep -q . "$1"'

summary_case "an empty response prints nothing" \
  '{"stop_reason":"end_turn","content":[]}' \
  '! grep -q . "$1"'

if ANTHROPIC_API_KEY="" bash "$ROOT/scripts/flowreview/ai-summary.sh" \
  "$WORK/pr.json" "$WORK/analysis.json" "$WORK/diff.patch" >"$OUT" 2>&1 && ! grep -q . "$OUT"; then
  ok
else
  bad "no API key prints nothing"
fi

printf 'flowreview tests: %d passed, %d failed\n' "$pass" "$failures"
[[ "$failures" -eq 0 ]]
