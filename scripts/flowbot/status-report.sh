#!/usr/bin/env bash
#
# FlowBot — pull-request status reporter.
#
# FlowBot is AgentFlow's own repository automation. It is NOT an official
# Drips or Stellar bot, and it is not a GitHub App. It consumes the results of
# the repository's EXISTING CI workflow (.github/workflows/ci.yml) and keeps
# exactly ONE sticky comment per pull request up to date.
#
# It never approves a pull request, never merges, never enables auto-merge,
# and never touches issues, labels, assignments, or repository settings.
#
# Normally invoked by .github/workflows/flowbot.yml. See docs/FLOWBOT.md.
#
# Environment:
#   GH_TOKEN               required  token with pull-requests:write, statuses:write
#   FLOWBOT_REPO          required  owner/repo
#   FLOWBOT_RUN_ID        required  the completed `CI` workflow run to report on
#   FLOWBOT_LOGIN         optional  comment author to update (default: github-actions[bot])
#   FLOWBOT_BASE_BRANCH   optional  base branch of the campaign (default: main)
#   FLOWBOT_CI_WORKFLOW   optional  CI workflow file name (default: ci.yml)
#   FLOWBOT_DRY_RUN       optional  set to 1 to print the comment instead of posting
#
# Exit codes: 0 = handled or deliberately skipped (never a FlowBot failure of
# the PR), 1 = FlowBot could not run (tooling/API problem).

set -euo pipefail

MARKER='<!-- flowbot:status -->'
STATUS_CONTEXT='FlowBot / ready-for-review'

log() { printf 'flowbot: %s\n' "$*"; }
warn() { printf '::warning::flowbot: %s\n' "$*" >&2; }
fail() {
  printf '::error::flowbot: %s\n' "$*" >&2
  exit 1
}

: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${FLOWBOT_REPO:?FLOWBOT_REPO must be set}"
: "${FLOWBOT_RUN_ID:?FLOWBOT_RUN_ID must be set}"

# The run ID reaches the API path verbatim, so constrain it before anything else.
# (It is normally a GitHub-generated integer, but workflow_dispatch accepts a
# typed string, and input must never be interpolated into a path unchecked.)
[[ "$FLOWBOT_RUN_ID" =~ ^[0-9]+$ ]] \
  || fail "FLOWBOT_RUN_ID must be a numeric workflow run ID, got: ${FLOWBOT_RUN_ID}"

FLOWBOT_LOGIN="${FLOWBOT_LOGIN:-github-actions[bot]}"
FLOWBOT_BASE_BRANCH="${FLOWBOT_BASE_BRANCH:-main}"
FLOWBOT_CI_WORKFLOW="${FLOWBOT_CI_WORKFLOW:-ci.yml}"
FLOWBOT_DRY_RUN="${FLOWBOT_DRY_RUN:-0}"

API="repos/${FLOWBOT_REPO}"

for tool in gh jq; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required but was not found on PATH"
done

# ---------------------------------------------------------------------------
# 1. Resolve the CI run and check that it is a pull-request run.
# ---------------------------------------------------------------------------
run_json=$(gh api "${API}/actions/runs/${FLOWBOT_RUN_ID}") \
  || fail "cannot read workflow run ${FLOWBOT_RUN_ID}"

run_event=$(jq -r '.event // ""' <<<"$run_json")
run_conclusion=$(jq -r '.conclusion // ""' <<<"$run_json")
run_url=$(jq -r '.html_url // ""' <<<"$run_json")
head_sha=$(jq -r '.head_sha // ""' <<<"$run_json")
head_branch=$(jq -r '.head_branch // ""' <<<"$run_json")
head_owner=$(jq -r '.head_repository.owner.login // ""' <<<"$run_json")
pr_from_run=$(jq -r '.pull_requests[0].number // empty' <<<"$run_json" 2>/dev/null || true)

if [[ "$run_event" != "pull_request" ]]; then
  log "run ${FLOWBOT_RUN_ID} event is '${run_event}', not a pull_request run — nothing to report."
  exit 0
fi

if [[ "$run_conclusion" == "cancelled" ]]; then
  # A cancelled run is not a verdict: it is usually superseded or cancelled by a
  # maintainer. Stay quiet so contributors are not pinged with a false failure.
  log "run ${FLOWBOT_RUN_ID} was cancelled — staying quiet (no stale report)."
  exit 0
fi

[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || fail "run ${FLOWBOT_RUN_ID} has no usable head SHA"

# ---------------------------------------------------------------------------
# 2. Resolve the pull request for this run.
# ---------------------------------------------------------------------------
pr_number="$pr_from_run"

if [[ -z "$pr_number" && -n "$head_owner" && -n "$head_branch" ]]; then
  # workflow_run payloads do not always carry pull_requests for fork heads;
  # look the PR up by head owner/branch instead.
  pr_number=$(gh api -X GET "${API}/pulls" \
    -f state=open \
    -f "head=${head_owner}:${head_branch}" \
    -f "base=${FLOWBOT_BASE_BRANCH}" \
    --jq '.[0].number // empty' 2>/dev/null || true)
fi

if [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
  log "no open pull request found for ${head_owner:-?}:${head_branch:-?} — nothing to report."
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Ignore superseded runs so the sticky comment never goes stale.
# ---------------------------------------------------------------------------
latest_run_id=$(gh api -X GET "${API}/actions/workflows/${FLOWBOT_CI_WORKFLOW}/runs" \
  -f "head_sha=${head_sha}" -f per_page=1 -f sort=created -f direction=desc \
  --jq '.workflow_runs[0].id // empty' 2>/dev/null || true)

if [[ -n "$latest_run_id" && "$latest_run_id" != "$FLOWBOT_RUN_ID" ]]; then
  log "run ${FLOWBOT_RUN_ID} was superseded by run ${latest_run_id} — skipping stale report."
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Collect the check results from the existing CI workflow.
# ---------------------------------------------------------------------------
jobs_json=$(gh api -X GET "${API}/actions/runs/${FLOWBOT_RUN_ID}/jobs" -f per_page=100) \
  || fail "cannot list jobs for run ${FLOWBOT_RUN_ID}"

total_count=$(jq '(.jobs // []) | length' <<<"$jobs_json")
passed_count=$(jq '[.jobs[]? | select(.conclusion == "success")] | length' <<<"$jobs_json")
skipped_count=$(jq '[.jobs[]? | select(.conclusion == "skipped" or .conclusion == "neutral")] | length' <<<"$jobs_json")
pending_count=$(jq '[.jobs[]? | select(.conclusion == null or .conclusion == "queued" or .conclusion == "in_progress" or .conclusion == "pending")] | length' <<<"$jobs_json")
failed_count=$(jq '[.jobs[]? | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out" or .conclusion == "action_required" or .conclusion == "stale")] | length' <<<"$jobs_json")

attention_lines=$(jq -r '.jobs[]?
  | select(.conclusion == null or .conclusion == "queued" or .conclusion == "in_progress" or .conclusion == "pending" or .conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out" or .conclusion == "action_required" or .conclusion == "stale")
  | "- `\(.name)` — \(.conclusion // "pending")"' <<<"$jobs_json")

# ---------------------------------------------------------------------------
# 5. Pull request metadata.
# ---------------------------------------------------------------------------
pr_json=$(gh api "${API}/pulls/${pr_number}") || fail "cannot read pull request #${pr_number}"
is_draft=$(jq -r '.draft // false' <<<"$pr_json")
pr_author=$(jq -r '.user.login // "unknown"' <<<"$pr_json")
pr_title=$(jq -r '.title // "Untitled pull request"' <<<"$pr_json")
base_branch=$(jq -r '.base.ref // "unknown"' <<<"$pr_json")
pr_url=$(jq -r '.html_url // ""' <<<"$pr_json")
changed_file_count=$(jq -r '.changed_files // 0' <<<"$pr_json")
addition_count=$(jq -r '.additions // 0' <<<"$pr_json")
deletion_count=$(jq -r '.deletions // 0' <<<"$pr_json")

# ---------------------------------------------------------------------------
# 6. Flag infrastructure files that always deserve maintainer scrutiny.
#    This is advisory only — FlowBot never blocks a PR by itself.
# ---------------------------------------------------------------------------
changed_files=$(gh api -X GET "${API}/pulls/${pr_number}/files" \
  -f per_page=100 --paginate --slurp 2>/dev/null \
  | jq -r '.[][]? | (.filename // empty)' 2>/dev/null || true)

sensitive_lines=""
while IFS= read -r changed; do
  [[ -z "$changed" ]] && continue
  case "$changed" in
    .github/workflows/*|.github/CODEOWNERS|.github/ISSUE_TEMPLATE/*|.github/PULL_REQUEST_TEMPLATE.md|scripts/flowbot/*|SECURITY.md)
      sensitive_lines+="- \`${changed}\`"$'\n'
      ;;
  esac
done <<<"$changed_files"

# ---------------------------------------------------------------------------
# 7. Compose the result summary.
# ---------------------------------------------------------------------------
if [[ "$total_count" -eq 0 ]]; then
  result_emoji="⏳"
  result_title="CI returned no jobs — waiting for a usable result"
  status_state="pending"
  status_desc="CI returned no jobs"
elif [[ "$failed_count" -gt 0 ]]; then
  result_emoji="🚦"
  result_title="Action needed before this pull request can move forward"
  status_state="failure"
  status_desc="${failed_count} CI check(s) need attention"
elif [[ "$pending_count" -gt 0 ]]; then
  result_emoji="⏳"
  result_title="CI is still running — the final review signal is not ready"
  status_state="pending"
  status_desc="CI is still running"
elif [[ "$is_draft" == "true" ]]; then
  result_emoji="📝"
  result_title="Automated checks passed — this draft is not yet ready for review"
  status_state="pending"
  status_desc="CI passed; pull request is still a draft"
else
  result_emoji="✅"
  result_title="Automated checks passed — ready for maintainer review"
  status_state="success"
  status_desc="All CI checks passed; awaiting human maintainer review"
fi

short_sha="${head_sha:0:7}"
body_file=$(mktemp)
trap 'rm -f "$body_file"' EXIT

{
  printf '%s\n' "$MARKER"
  printf '## %s FlowBot — review brief\n\n' "$result_emoji"
  printf '> **%s**\n\n' "$result_title"
  printf '**Pull request:** [%s](%s)\n\n' "$pr_title" "$pr_url"

  printf '### At a glance\n\n'
  printf '| Signal | Result |\n| --- | --- |\n'
  printf '| CI run | [#%s](%s) |\n' "$FLOWBOT_RUN_ID" "$run_url"
  printf '| Commit | `%s` |\n' "$short_sha"
  printf '| Target | `%s` |\n' "$base_branch"
  printf '| Author | @%s |\n' "$pr_author"
  printf '| Scope | %s file(s), +%s / -%s lines |\n' "$changed_file_count" "$addition_count" "$deletion_count"
  printf '| Checks | %s passed · %s skipped · %s pending · %s needing attention |\n\n' \
    "$passed_count" "$skipped_count" "$pending_count" "$failed_count"

  if [[ "$is_draft" == "true" ]]; then
    printf 'This pull request is currently a **draft**, so it is not yet queued for maintainer review.\n\n'
  fi

  if [[ "$failed_count" -gt 0 ]]; then
    printf '### Checks that need attention\n\n%s\n\n' "$attention_lines"
    cat <<'EOF'
### Recommended next step

Resolve the checks listed above, then push to the same branch. FlowBot
will refresh this brief in place when the next CI run completes.

Reproduce the required checks locally before pushing again:

EOF
    cat <<'EOF'
```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
cargo audit
```
EOF
    cat <<'EOF'

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full command reference,
including the WASM size budget and the provenance manifest check.

EOF
  elif [[ "$pending_count" -gt 0 || "$total_count" -eq 0 ]]; then
    printf '### Current state\n\n'
    printf 'CI has not reached a final result yet. FlowBot will refresh this brief when the run completes.\n\n'
  else
    cat <<'EOF'
### Recommended next step

All automated checks in the existing CI workflow passed. This pull request is
now **eligible for human maintainer/CODEOWNER review**. FlowBot does **not**
approve and does **not** merge; a human approval is still required.

EOF
  fi

  if [[ -n "$sensitive_lines" ]]; then
    cat <<'EOF'
### Maintainer attention

This pull request changes repository automation or security configuration:

EOF
    printf '%s\n' "$sensitive_lines"
    cat <<'EOF'

These paths are not blocked by FlowBot, but they should not be merged without
explicit maintainer sign-off.

EOF
  fi

  cat <<'EOF'
---

<sub>**FlowBot** is AgentFlow's own pull-request automation, executed as the
GitHub Actions identity `github-actions[bot]`. It is **not** an official Drips or
Stellar bot. It reports CI results only: it never reviews, approves, or merges,
never enables auto-merge, and never modifies issues, labels, assignments,
CODEOWNERS, or repository settings. Report FlowBot problems to the maintainers;
see [docs/FLOWBOT.md](docs/FLOWBOT.md).</sub>
EOF
} > "$body_file"

if [[ "$FLOWBOT_DRY_RUN" == "1" ]]; then
  log "dry run: comment body for PR #${pr_number} (state would be ${status_state}):"
  cat "$body_file"
  exit 0
fi

# ---------------------------------------------------------------------------
# 8. Upsert the single sticky comment (prevents duplicate bot comments).
# ---------------------------------------------------------------------------
comments=$(gh api -X GET "${API}/issues/${pr_number}/comments" \
  -f per_page=100 --paginate --slurp 2>/dev/null || printf '[]')

existing_id=$(jq -r --arg login "$FLOWBOT_LOGIN" --arg marker "$MARKER" \
  '[.[]? | .[]? | select((.user.login // "") == $login
     and ((.body // "") | contains($marker)))] | (last // {}) | (.id // empty)' \
  <<<"$comments" 2>/dev/null || true)

if [[ -n "$existing_id" ]]; then
  gh api -X PATCH "${API}/issues/comments/${existing_id}" -F "body=@${body_file}" >/dev/null \
    || fail "failed to update FlowBot comment ${existing_id}"
  log "updated sticky comment ${existing_id} on PR #${pr_number} (${status_state})."
else
  gh api -X POST "${API}/issues/${pr_number}/comments" -F "body=@${body_file}" >/dev/null \
    || fail "failed to create FlowBot comment on PR #${pr_number}"
  log "created sticky comment on PR #${pr_number} (${status_state})."
fi

# ---------------------------------------------------------------------------
# 9. Publish the informational commit status.
#    It is a signal only; git-branch protection still requires human review.
# ---------------------------------------------------------------------------
if gh api -X POST "${API}/statuses/${head_sha}" \
  -f state="$status_state" \
  -f context="$STATUS_CONTEXT" \
  -f description="$status_desc" >/dev/null 2>&1; then
  log "commit status '${STATUS_CONTEXT}' set to '${status_state}' on ${short_sha}."
else
  warn "could not publish commit status on ${short_sha} (informational only; comment already posted)."
fi
