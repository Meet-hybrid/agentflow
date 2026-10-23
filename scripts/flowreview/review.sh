#!/usr/bin/env bash
#
# FlowReview — review assistant for pull requests.
#
# After CI finishes on a pull request, FlowReview reads the PR's changes as git
# objects, runs the deterministic analyzer (analyze.py), optionally adds an AI
# summary (ai-summary.sh), and keeps exactly ONE sticky comment per pull request
# telling the maintainer where to look before approving.
#
# It never approves, never merges, never checks out or executes pull-request
# code, and never touches labels, statuses or settings. It is advisory only:
# required CODEOWNER review and FlowGuard are unchanged.
#
# Normally invoked by .github/workflows/flowreview.yml. See docs/FLOWREVIEW.md.
#
# Environment:
#   GH_TOKEN                  required  token with pull-requests:write
#   FLOWREVIEW_REPO          required  owner/repo
#   FLOWREVIEW_RUN_ID        required  the completed `CI` workflow run
#   FLOWREVIEW_LOGIN         optional  comment author to update (default: github-actions[bot])
#   FLOWREVIEW_DRY_RUN       optional  set to 1 to print the comment instead of posting
#   ANTHROPIC_API_KEY         optional  enables the AI summary (see ai-summary.sh)
#
# Exit codes: 0 = handled or deliberately skipped, 1 = FlowReview could not run.

set -euo pipefail

MARKER='<!-- flowreview -->'
HERE="$(cd "$(dirname "$0")" && pwd)"

log() { printf 'flowreview: %s\n' "$*"; }
fail() {
  printf '::error::flowreview: %s\n' "$*" >&2
  exit 1
}

: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${FLOWREVIEW_REPO:?FLOWREVIEW_REPO must be set}"
: "${FLOWREVIEW_RUN_ID:?FLOWREVIEW_RUN_ID must be set}"

# Values below reach API paths or git refspecs, so constrain them first.
[[ "$FLOWREVIEW_RUN_ID" =~ ^[0-9]+$ ]] \
  || fail "FLOWREVIEW_RUN_ID must be a numeric workflow run ID, got: ${FLOWREVIEW_RUN_ID}"
[[ "$FLOWREVIEW_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || fail "FLOWREVIEW_REPO must be owner/repo, got: ${FLOWREVIEW_REPO}"

FLOWREVIEW_LOGIN="${FLOWREVIEW_LOGIN:-github-actions[bot]}"
FLOWREVIEW_DRY_RUN="${FLOWREVIEW_DRY_RUN:-0}"
API="repos/${FLOWREVIEW_REPO}"

for tool in gh jq git python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required but was not found on PATH"
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# 1. Resolve the CI run and its pull request.
# ---------------------------------------------------------------------------
run_json=$(gh api "${API}/actions/runs/${FLOWREVIEW_RUN_ID}") \
  || fail "cannot read workflow run ${FLOWREVIEW_RUN_ID}"

run_event=$(jq -r '.event // ""' <<<"$run_json")
run_conclusion=$(jq -r '.conclusion // ""' <<<"$run_json")
head_sha=$(jq -r '.head_sha // ""' <<<"$run_json")
head_branch=$(jq -r '.head_branch // ""' <<<"$run_json")
head_owner=$(jq -r '.head_repository.owner.login // ""' <<<"$run_json")
pr_number=$(jq -r '.pull_requests[0].number // empty' <<<"$run_json")

if [[ "$run_event" != "pull_request" ]]; then
  log "run ${FLOWREVIEW_RUN_ID} event is '${run_event}', not a pull_request run — nothing to review."
  exit 0
fi
if [[ "$run_conclusion" == "cancelled" ]]; then
  log "run ${FLOWREVIEW_RUN_ID} was cancelled — staying quiet."
  exit 0
fi
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || fail "run ${FLOWREVIEW_RUN_ID} has no usable head SHA"

if [[ -z "$pr_number" && -n "$head_owner" && -n "$head_branch" ]]; then
  # workflow_run payloads do not always carry pull_requests for fork heads.
  pr_number=$(gh api -X GET "${API}/pulls" -f state=open -f "head=${head_owner}:${head_branch}" \
    --jq '.[0].number // empty' 2>/dev/null || true)
fi
if [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
  log "no open pull request found for ${head_owner:-?}:${head_branch:-?} — nothing to review."
  exit 0
fi

pr_json=$(gh api "${API}/pulls/${pr_number}") || fail "cannot read pull request #${pr_number}"
if [[ "$(jq -r '.head.sha' <<<"$pr_json")" != "$head_sha" ]]; then
  log "PR #${pr_number} moved past ${head_sha:0:12} — a newer CI run will be reviewed instead."
  exit 0
fi
base_ref=$(jq -r '.base.ref' <<<"$pr_json")
[[ "$base_ref" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "unexpected base branch name: ${base_ref}"

# ---------------------------------------------------------------------------
# 2. Fetch the PR head as git objects only — nothing from it is checked out.
# ---------------------------------------------------------------------------
git fetch --quiet --no-tags origin \
  "+refs/heads/${base_ref}:refs/flowreview/base" \
  "+refs/pull/${pr_number}/head:refs/flowreview/head" \
  || fail "cannot fetch base and head of PR #${pr_number}"
[[ "$(git rev-parse refs/flowreview/head)" == "$head_sha" ]] || {
  log "PR #${pr_number} head changed while fetching — skipping stale review."
  exit 0
}

# ---------------------------------------------------------------------------
# 3. Analyze, and optionally summarize with AI.
# ---------------------------------------------------------------------------
python3 "$HERE/analyze.py" refs/flowreview/base refs/flowreview/head >"$WORK/analysis.json" \
  || fail "analyzer failed for PR #${pr_number}"

merge_base=$(git merge-base refs/flowreview/base refs/flowreview/head)
git -c core.quotePath=false diff --no-ext-diff --no-textconv --no-renames \
  "$merge_base" refs/flowreview/head >"$WORK/diff.patch"
jq '{title, body, author: .user.login, base: .base.ref}' <<<"$pr_json" >"$WORK/pr.json"

ai_summary=$(bash "$HERE/ai-summary.sh" "$WORK/pr.json" "$WORK/analysis.json" "$WORK/diff.patch")

# ---------------------------------------------------------------------------
# 4. Compose the comment.
# ---------------------------------------------------------------------------
body_file="$WORK/body.md"
risk=$(jq -r '.risk' "$WORK/analysis.json")
case "$risk" in
  high) risk_label='🔴 HIGH' ;;
  medium) risk_label='🟠 MEDIUM' ;;
  *) risk_label='🟢 LOW' ;;
esac

{
  printf '%s\n' "$MARKER"
  printf '## 🔍 FlowReview — `%s`\n\n' "${head_sha:0:7}"
  printf '> Advisory only. FlowReview never approves or merges; a maintainer must still review and approve.\n\n'
  jq -r --arg risk "$risk_label" '
    "**Risk:** \($risk) · **Changed:** \(.totals.files) files (+\(.totals.additions) / −\(.totals.deletions))\n"' \
    "$WORK/analysis.json"

  printf '### Look closely at\n\n'
  jq -r '
    def code: "`" + (tostring | gsub("`"; "")) + "`";
    if (.findings | length) == 0 then "Nothing flagged by the rules."
    else
      (.findings | sort_by(if .level == "high" then 0 else 1 end) | .[:25][]
        | "- \(if .level == "high" then "🔴" else "🟠" end) \(.location | code) — \(.message)"),
      (if (.findings | length) > 25 then "- …and \((.findings | length) - 25) more" else empty end)
    end' "$WORK/analysis.json"
  printf '\n'

  if [[ -n "$ai_summary" ]]; then
    printf '### AI summary\n\n'
    printf '> Written by Claude from the PR text and diff. The PR author controls that text, so treat this as a hint, not a verdict.\n\n'
    printf '%s\n\n' "$ai_summary"
  fi

  printf '<details><summary>Changed files</summary>\n\n| File | Change | Kind |\n| --- | --- | --- |\n'
  jq -r '
    def code: "`" + (tostring | gsub("[`|]"; "")) + "`";
    .files[:60][] | "| \(.path | code) | \(.status) +\(.additions)/−\(.deletions) | \(.category) |"' \
    "$WORK/analysis.json"
  jq -r 'if (.files | length) > 60 then "\n…and \((.files | length) - 60) more files" else empty end' "$WORK/analysis.json"
  printf '\n</details>\n\n'
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    printf '<sub>AI summary is off (no `ANTHROPIC_API_KEY` secret). See docs/FLOWREVIEW.md.</sub>\n'
  else
    printf '<sub>FlowReview · rules + AI summary · see docs/FLOWREVIEW.md</sub>\n'
  fi
} >"$body_file"

if [[ "$FLOWREVIEW_DRY_RUN" == "1" ]]; then
  log "dry run — comment for PR #${pr_number}:"
  cat "$body_file"
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. Upsert the single sticky comment.
# ---------------------------------------------------------------------------
existing_id=$(gh api -X GET "${API}/issues/${pr_number}/comments" -f per_page=100 --paginate \
  --jq ".[] | select(.user.login == \"${FLOWREVIEW_LOGIN}\" and (.body | startswith(\"${MARKER}\"))) | .id" \
  2>/dev/null | head -n1 || true)

if [[ "$existing_id" =~ ^[0-9]+$ ]]; then
  gh api -X PATCH "${API}/issues/comments/${existing_id}" -F "body=@${body_file}" >/dev/null \
    || fail "cannot update comment ${existing_id} on PR #${pr_number}"
  log "updated review comment on PR #${pr_number} (risk: ${risk})."
else
  gh api -X POST "${API}/issues/${pr_number}/comments" -F "body=@${body_file}" >/dev/null \
    || fail "cannot comment on PR #${pr_number}"
  log "posted review comment on PR #${pr_number} (risk: ${risk})."
fi
