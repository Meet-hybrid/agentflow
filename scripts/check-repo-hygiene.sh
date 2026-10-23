#!/usr/bin/env bash
# Guard against the auto-run malware pattern removed in #520/#521: editor
# configs that execute on folder open, payloads disguised as font/binary files,
# and npm lifecycle hooks that run on install.
#
# Usage: check-repo-hygiene.sh [REF]
#   With no REF, checks the files tracked in the working tree.
#   With a REF, checks that commit's tree straight from the object database,
#   without checking it out (used by FlowGuard on untrusted PR heads).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REF="${1:-}"

if [ -n "$REF" ]; then
    git rev-parse --verify --quiet "${REF}^{commit}" >/dev/null || {
        echo "Error: unknown ref '$REF'"
        exit 2
    }
    echo "Checking repository hygiene at ${REF}..."
    tracked="$(git ls-tree -r --name-only "$REF")"
    read_file() { git cat-file blob "${REF}:$1"; }
    grep_tree() { git grep --no-textconv -nIE "$1" "$REF" -- "${@:2}" | sed "s|^${REF}:||"; }
else
    echo "Checking repository hygiene..."
    tracked="$(git ls-files)"
    read_file() { cat "$1"; }
    grep_tree() { git grep -nIE "$1" -- "${@:2}"; }
fi

failed=0
fail() {
    echo "Error: $1"
    failed=1
}

# Editor/IDE/devcontainer configs can execute commands when a folder is opened.
if hits="$(grep -E '(^|/)\.(vscode|cursor|idea|devcontainer)/' <<<"$tracked")"; then
    fail "editor or devcontainer config must not be committed:"
    sed 's/^/  /' <<<"$hits"
fi

# Fonts and native binaries have no place in this repo and are a common
# hiding spot for payloads.
if hits="$(grep -iE '\.(woff2?|eot|ttf|otf|llf|exe|dll|so|dylib|bat|cmd|ps1|scr|jar)$' <<<"$tracked")"; then
    fail "font or binary files must not be committed:"
    sed 's/^/  /' <<<"$hits"
fi

# npm lifecycle hooks run arbitrary code on `npm install`.
while IFS= read -r manifest; do
    [ -n "$manifest" ] || continue
    if hooks="$(read_file "$manifest" | grep -nE '"(preinstall|install|postinstall|prepare|prepublish|prepack|postpack)"[[:space:]]*:')"; then
        fail "npm lifecycle script in $manifest:"
        sed 's/^/  /' <<<"$hooks"
    fi
done < <(grep -E '(^|/)package\.json$' <<<"$tracked" || true)

# Settings that let tasks run without a prompt, in any config file.
if hits="$(grep_tree 'allowAutomaticTasks|"runOn"[[:space:]]*:[[:space:]]*"folderOpen"' '*.json' '*.jsonc' '*.code-workspace' || true)" && [ -n "$hits" ]; then
    fail "auto-run task settings found:"
    sed 's/^/  /' <<<"$hits"
fi

if [ "$failed" -ne 0 ]; then
    echo ""
    echo "Repository hygiene check failed. See SECURITY.md for why these are blocked."
    exit 1
fi

echo "Repository hygiene check passed."
