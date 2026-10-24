#!/usr/bin/env bash
#
# FlowGuard — pull-request malware scanner.
#
# Scans the changes a pull request introduces (merge-base of BASE..HEAD) for
# the patterns used by supply-chain malware: auto-run editor tasks, payloads
# disguised as fonts or binaries, npm lifecycle hooks, non-registry dependency
# sources, obfuscated code, Trojan Source characters and build-time code.
#
# It reads git objects only. It never checks out, builds, installs or executes
# anything from HEAD, so it is safe to run on untrusted pull requests.
#
# Usage: scan-pr.sh BASE_REF HEAD_REF
#
# Output: one finding per line, tab-separated: LEVEL, LOCATION, REASON.
#   BLOCK   — malware pattern or banned content; the PR must not be merged.
#   REVIEW  — sensitive change; a maintainer must merge it by hand.
# Finding text never includes file content, only paths and line numbers.
#
# Exit codes: 0 = clean, 1 = REVIEW findings only, 2 = BLOCK findings,
# 3 = FlowGuard could not run.

set -euo pipefail
export LC_ALL=C.UTF-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

die() {
  printf 'flowguard: %s\n' "$*" >&2
  exit 3
}

[[ $# -eq 2 ]] || die "usage: scan-pr.sh BASE_REF HEAD_REF"
base=$(git rev-parse --verify --quiet "${1}^{commit}") || die "unknown base ref: $1"
head=$(git rev-parse --verify --quiet "${2}^{commit}") || die "unknown head ref: $2"
merge_base=$(git merge-base "$base" "$head") || die "no merge base between $1 and $2"

# Never let repository config or attributes from the PR influence the diff.
gitd() { git -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames "$@"; }

findings=()
declare -A banned=()
block() { findings+=("BLOCK"$'\t'"$1"$'\t'"$2"); }
review() { findings+=("REVIEW"$'\t'"$1"$'\t'"$2"); }

# ---------------------------------------------------------------------------
# 1. Whole-tree hygiene of HEAD (the same rules CI enforces).
# ---------------------------------------------------------------------------
if ! hygiene=$(bash "$ROOT/scripts/check-repo-hygiene.sh" "$head" 2>&1); then
  # Reduce each hit to PATH or PATH:LINE so no file content is echoed.
  while IFS= read -r line; do
    case "$line" in
      "Error: npm lifecycle script in "*)
        reason="npm lifecycle script"
        manifest="${line#Error: npm lifecycle script in }"
        manifest="${manifest%:}"
        ;;
      Error:*) reason="${line#Error: }"; reason="${reason%:}"; manifest="" ;;
      "  "*)
        hit="${line#  }"
        if [[ -n "$manifest" && "$hit" =~ ^([0-9]+): ]]; then
          block "${manifest}:${BASH_REMATCH[1]}" "$reason"
        elif [[ "$hit" =~ ^([^:]+):([0-9]+): ]]; then
          block "${BASH_REMATCH[1]}:${BASH_REMATCH[2]}" "$reason"
        else
          block "$hit" "$reason"
          banned["$hit"]=1
        fi
        ;;
    esac
  done <<<"$hygiene"
fi

# ---------------------------------------------------------------------------
# 2. Per-file checks on every added or modified path.
# ---------------------------------------------------------------------------
declare -A binary=()
while IFS=$'\t' read -r added _ path; do
  [[ "$added" == "-" ]] && binary["$path"]=1
done < <(gitd --numstat "$merge_base" "$head")

is_image() { [[ "$1" =~ \.(png|jpe?g|gif|webp|ico)$ ]]; }

while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
  read -r old_mode new_mode _ new_sha status <<<"${meta#:}"
  [[ "$status" == D ]] && continue

  case "$new_mode" in
    120000) block "$path" "symbolic link added"; continue ;;
    160000) block "$path" "git submodule added"; continue ;;
    100755) [[ "$old_mode" != 100755 && ! "$path" =~ ^scripts/.*\.sh$ ]] \
      && review "$path" "new executable file outside scripts/" ;;
  esac

  [[ "$path" == .gitmodules ]] && block "$path" "git submodule configuration"
  [[ "$path" == .gitattributes || "$path" == */.gitattributes ]] \
    && review "$path" "git attributes can change how files are checked out"

  if [[ -n "${binary[$path]:-}" && -z "${banned[$path]:-}" ]]; then
    if is_image "$path"; then
      review "$path" "binary image added or changed"
    else
      block "$path" "binary file added or changed"
    fi
  fi

  size=$(git cat-file -s "$new_sha")
  ((size > 1048576)) && review "$path" "file larger than 1 MiB"

  # Code that runs at build or install time, or that controls CI and review.
  dir=$(dirname "$path")
  [[ "$dir" == . ]] && dir=""
  if [[ "$(basename "$path")" == build.rs ]] \
    && git cat-file -e "${head}:${dir:+$dir/}Cargo.toml" 2>/dev/null; then
    review "$path" "Cargo build script (runs on every cargo build)"
  fi
  case "$path" in
    .cargo/* | */.cargo/*) review "$path" "Cargo config can override the compiler or runner" ;;
    rust-toolchain* | */rust-toolchain*) review "$path" "toolchain change" ;;
    .github/*) review "$path" "CI, CODEOWNERS or repository automation change" ;;
    scripts/* | Makefile | */Makefile) review "$path" "build or automation script change" ;;
  esac
done < <(gitd --raw -z "$merge_base" "$head")

# ---------------------------------------------------------------------------
# 3. Content checks on added lines. Line N of $added_text is the text of an
#    added line; line N of $added_loc is its PATH<TAB>LINE.
# ---------------------------------------------------------------------------
added_text=$(mktemp)
added_loc=$(mktemp)
trap 'rm -f "$added_text" "$added_loc"' EXIT

gitd -U0 --diff-filter=AM "$merge_base" "$head" | awk '
  /^diff --git / { in_hunk = 0; path = ""; next }
  !in_hunk && /^\+\+\+ / { path = substr($0, 5); sub(/^b\//, "", path); next }
  /^@@ / {
    in_hunk = 1
    split($3, r, ","); line = substr(r[1], 2) - 1
    next
  }
  in_hunk && /^\+/ {
    line++
    print substr($0, 2) >text
    print path "\t" line >loc
    next
  }
' text="$added_text" loc="$added_loc"

# match LEVEL PATH_REGEX TEXT_PCRE REASON — report each matching PATH:LINE.
# A PATH_REGEX starting with "!" matches paths that do NOT match the rest.
match() {
  local level=$1 path_re=$2 text_re=$3 reason=$4 loc
  while IFS= read -r loc; do
    [[ -n "$loc" ]] && "$level" "$loc" "$reason"
  done < <(grep -nP -- "$text_re" "$added_text" 2>/dev/null | cut -d: -f1 \
    | PATH_RE="$path_re" awk -F'\t' '
        # Read the regex from ENVIRON: -v would turn "\." into ".".
        BEGIN { re = ENVIRON["PATH_RE"]; neg = substr(re, 1, 1) == "!"; if (neg) re = substr(re, 2) }
        NR == FNR { want[$1] = 1; next }
        (FNR in want) && (($1 ~ re) != neg) { print $1 ":" $2 }' - "$added_loc" | head -n 20)
}

code='\.(m?js|cjs|jsx|ts|tsx|mts|cts|rs|sh|py|ps1|ya?ml|toml)$'
any='.'
code_not_lock='\.(m?js|cjs|jsx|ts|tsx|mts|cts|rs|sh|py|ya?ml|toml)$'
js='\.(m?js|cjs|jsx|ts|tsx|mts|cts)$'
workflow='^\.github/workflows/'
prose='\.(md|mdx|txt|html?|csv|svg)$'
# Soroban contract specs are embedded as base64 XDR entries, which always
# begin with "AAAA". Decoding-and-executing is caught separately below.
spec_entry='^[^"]{0,40}"AAAA[A-Za-z0-9+/=]*"[\s,\])};]*$'

# Trojan Source: bidirectional controls and invisible characters.
match block "$any" '[\x{202A}-\x{202E}\x{2066}-\x{2069}\x{200B}-\x{200D}\x{2060}\x{FEFF}]' \
  "bidirectional or invisible Unicode character (Trojan Source)"

# Known payloads hide their code after hundreds of spaces on a single line.
match block "!$prose" '[ \t]{150,}[^ \t]' "code hidden after a long run of whitespace"
match block "$prose" '^(?=.{1000,}).*[ \t]{150,}[^ \t]' "code hidden after a long run of whitespace"

match block "$js" '(?:eval|Function)\s*\(\s*(?:atob|Buffer\.from|unescape|decodeURIComponent)\b' \
  "decodes and executes an embedded string"
match block '(^|/)package-lock\.json$' '"resolved"\s*:\s*"(?!https://registry\.npmjs\.org/)' \
  "npm dependency resolved from outside registry.npmjs.org"
match block '(^|/)pnpm-lock\.yaml$' 'resolution:\s*\{[^}]*\b(?:tarball|repo|commit)\s*:' \
  "pnpm dependency resolved from a tarball URL or git repository"
match block '(^|/)package\.json$' '"\s*:\s*"(?:git\+|git:|github:|gitlab:|bitbucket:|https?://)[^"]*"' \
  "npm dependency installed from a git or URL source"
match block '(^|/)Cargo\.toml$' '^\s*(?:[\w-]+\s*=\s*\{[^}]*)?\b(?:git|registry|registry-index)\s*=' \
  "Cargo dependency from a git repository or alternative registry"

match review "$js" '\b(?:child_process|eval\s*\(|new\s+Function\s*\(|vm\.run|process\.binding)' \
  "spawns processes or evaluates code at runtime"
match review "$code" '\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){15,}' "long hex-escaped string"
match review "$code_not_lock" '(?<![A-Za-z0-9+/])(?!AAAA)[A-Za-z0-9+/]{400,}={0,2}' "large base64-like blob"
match review "$code_not_lock" "^(?!${spec_entry}).{2000,}\$" "line longer than 2000 characters"
match review "$any" '\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b' "pipes a download into a shell"
match review '(^|/)Cargo\.toml$' '^\s*\[(?:target\.[^]]+\.)?build-dependencies\]|proc-macro\s*=\s*true|^\s*build\s*=' \
  "adds build-time Rust code (build script, build dependency or proc macro)"
match review "$workflow" 'pull_request_target|workflow_run|secrets\.|permissions:|id-token' \
  "workflow trigger, permission or secret usage"

# ---------------------------------------------------------------------------
# 4. Report.
# ---------------------------------------------------------------------------
((${#findings[@]} == 0)) && exit 0
printf '%s\n' "${findings[@]}" | sort -u
printf '%s\n' "${findings[@]}" | grep -q '^BLOCK' && exit 2
exit 1
