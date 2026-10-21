#!/usr/bin/env bash
#
# ForgeGuard — scan-then-merge bot for approved pull requests.
#
# For each open pull request, ForgeGuard scans the PR's changes for malware
# patterns (scan-pr.sh), publishes the result as a commit status, and merges
# the PR only when ALL of the following hold:
#
#   - the scan found nothing (any finding means a maintainer merges by hand);
#   - every check on the head commit passed and the required checks exist;
#   - a user with write access approved the CURRENT head commit, nobody's
#     latest review requests changes, and the author did not approve alone;
#   - the PR is not a draft, targets an allowed branch and has no hold label;
#   - GitHub reports the PR as mergeable.
#
# ForgeGuard never approves, never bypasses branch protection, and never
# checks out or executes pull request code: PR heads are fetched as git
# objects and only read. The merge is pinned to the scanned head SHA, so a
# push that lands after the scan makes the merge fail instead of slipping in.
#
# Normally invoked by .github/workflows/forgeguard.yml. See docs/FORGEGUARD.md.
#
# Environment:
#   GH_TOKEN                    required  token with contents/pull-requests/statuses: write
#   FORGEGUARD_REPO             required  owner/repo
#   FORGEGUARD_PR               optional  only process this PR number
#   FORGEGUARD_BRANCHES         optional  space-separated base branches (default: main)
#   FORGEGUARD_MERGE_METHOD     optional  squash, rebase or merge (default: squash)
#   FORGEGUARD_REQUIRED_CHECKS  optional  comma-separated checks that must exist and pass
#                                         (default: Repo hygiene,Contract,TypeScript,Security Audit)
#   FORGEGUARD_IGNORED_CHECKS   optional  regex of check names to ignore (default: ^Vercel)
#   FORGEGUARD_HOLD_LABELS      optional  comma-separated labels that block merging
#                                         (default: do-not-merge,forgeguard:hold)
#   FORGEGUARD_DRY_RUN          optional  set to 1 to report without posting or merging
#
# Exit codes: 0 = all PRs handled (merged or deliberately skipped),
# 1 = ForgeGuard could not run (tooling/API problem).

set -euo pipefail

MARKER='<!-- forgeguard:scan -->'
STATUS_CONTEXT='ForgeGuard / malware-scan'

log() { printf 'forgeguard: %s\n' "$*"; }
warn() { printf '::warning::forgeguard: %s\n' "$*" >&2; }
fail() {
  printf '::error::forgeguard: %s\n' "$*" >&2
  exit 1
}

: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${FORGEGUARD_REPO:?FORGEGUARD_REPO must be set}"

FORGEGUARD_PR="${FORGEGUARD_PR:-}"
FORGEGUARD_BRANCHES="${FORGEGUARD_BRANCHES:-main}"
FORGEGUARD_MERGE_METHOD="${FORGEGUARD_MERGE_METHOD:-squash}"
FORGEGUARD_REQUIRED_CHECKS="${FORGEGUARD_REQUIRED_CHECKS:-Repo hygiene,Contract,TypeScript,Security Audit}"
FORGEGUARD_IGNORED_CHECKS="${FORGEGUARD_IGNORED_CHECKS:-^Vercel}"
FORGEGUARD_HOLD_LABELS="${FORGEGUARD_HOLD_LABELS:-do-not-merge,forgeguard:hold}"
FORGEGUARD_DRY_RUN="${FORGEGUARD_DRY_RUN:-0}"

# Values below reach API paths or git refspecs, so constrain them first.
[[ "$FORGEGUARD_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || fail "FORGEGUARD_REPO must look like owner/repo, got: ${FORGEGUARD_REPO}"
[[ -z "$FORGEGUARD_PR" || "$FORGEGUARD_PR" =~ ^[0-9]+$ ]] \
  || fail "FORGEGUARD_PR must be a pull request number, got: ${FORGEGUARD_PR}"
[[ "$FORGEGUARD_MERGE_METHOD" =~ ^(squash|rebase|merge)$ ]] \
  || fail "FORGEGUARD_MERGE_METHOD must be squash, rebase or merge"

API="repos/${FORGEGUARD_REPO}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCANNER="${ROOT}/scripts/forgeguard/scan-pr.sh"

for tool in gh jq git; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required but was not found on PATH"
done

summary=()
note() {
  log "#$1: $2"
  summary+=("| #$1 | $2 |")
}

dry() { [[ "$FORGEGUARD_DRY_RUN" == 1 ]]; }

# Strip characters that could break out of a markdown code span or table.
md_safe() { tr -d '`|\r\n<>' <<<"$1"; }

# ---------------------------------------------------------------------------
# GitHub side effects. In dry-run mode these only log what they would do.
# ---------------------------------------------------------------------------
set_status() { # SHA STATE DESCRIPTION
  dry && { log "  [dry-run] status ${2}: ${3}"; return 0; }
  gh api -X POST "${API}/statuses/$1" -f state="$2" -f context="$STATUS_CONTEXT" \
    -f description="$3" >/dev/null || warn "could not set status on $1"
}

upsert_comment() { # PR BODY CREATE_IF_MISSING
  local pr=$1 body=$2 create=$3 existing id old
  existing=$(gh api "${API}/issues/${pr}/comments" --paginate \
    --jq "map(select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"${MARKER}\")))) | first // empty" \
    2>/dev/null | jq -s 'first // empty') || existing=""
  id=$(jq -r '.id // empty' <<<"$existing")
  old=$(jq -r '.body // empty' <<<"$existing")
  [[ "$old" == "$body" ]] && return 0
  [[ -z "$id" && "$create" != 1 ]] && return 0
  if dry; then
    log "  [dry-run] would ${id:+update}${id:-create} scan comment"
  elif [[ -n "$id" ]]; then
    gh api -X PATCH "${API}/issues/comments/${id}" -f body="$body" >/dev/null \
      || warn "could not update comment on #${pr}"
  else
    gh api -X POST "${API}/issues/${pr}/comments" -f body="$body" >/dev/null \
      || warn "could not comment on #${pr}"
  fi
}

scan_comment() { # SHA RC FINDINGS
  local sha=$1 rc=$2 findings=$3 level loc reason
  printf '%s\n' "$MARKER"
  if [[ "$rc" == 0 ]]; then
    printf '### ForgeGuard scan: clean\n\nNo malware patterns found at `%s`.\n' "${sha:0:12}"
    return
  fi
  if [[ "$rc" == 2 ]]; then
    printf '### ForgeGuard scan: blocked\n\n'
    printf 'This PR contains patterns used by supply-chain malware and must not be merged.\n'
    printf '**Do not open this branch in an editor or run `npm install` on it.**\n\n'
  else
    printf '### ForgeGuard scan: needs maintainer review\n\n'
    printf 'This PR touches sensitive code, so ForgeGuard will not merge it automatically.\n'
    printf 'A maintainer can merge it by hand after checking the items below.\n\n'
  fi
  printf '| Level | Location | Reason |\n|---|---|---|\n'
  while IFS=$'\t' read -r level loc reason; do
    [[ -n "$level" ]] && printf '| %s | `%s` | %s |\n' "$level" "$(md_safe "$loc")" "$(md_safe "$reason")"
  done <<<"$findings"
  printf '\nScanned head `%s`. See docs/FORGEGUARD.md.\n' "${sha:0:12}"
}

# ---------------------------------------------------------------------------
# Merge gates. Each prints a reason and returns 1 when the PR is not ready.
# ---------------------------------------------------------------------------
check_reviews() { # PR AUTHOR SHA
  local pr=$1 author=$2 sha=$3 latest approver permission ok=0
  latest=$(gh api "${API}/pulls/${pr}/reviews" --paginate --jq '.[]' | jq -s '
    map(select(.state != "COMMENTED" and .state != "PENDING"))
    | group_by(.user.login) | map(max_by(.submitted_at))') \
    || { echo "could not read reviews"; return 1; }

  if jq -e 'any(.[]; .state == "CHANGES_REQUESTED")' <<<"$latest" >/dev/null; then
    echo "changes requested"
    return 1
  fi
  while IFS= read -r approver; do
    [[ -z "$approver" || "$approver" == "$author" ]] && continue
    permission=$(gh api "${API}/collaborators/${approver}/permission" --jq '.permission' 2>/dev/null) || continue
    [[ "$permission" == admin || "$permission" == write ]] && ok=1
  done < <(jq -r --arg sha "$sha" '.[] | select(.state == "APPROVED" and .commit_id == $sha) | .user.login' <<<"$latest")

  ((ok)) || { echo "no write-access approval of the current head"; return 1; }
}

check_ci() { # SHA
  local sha=$1 checks name required missing
  checks=$( {
    gh api "${API}/commits/${sha}/check-runs" --paginate \
      --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv'
    gh api "${API}/commits/${sha}/status" \
      --jq '.statuses[] | [.context, (if .state == "pending" then "in_progress" else "completed" end), .state] | @tsv'
  } | awk -F'\t' -v own="$STATUS_CONTEXT" -v ignore="$FORGEGUARD_IGNORED_CHECKS" \
      '$1 != own && $1 !~ ignore') || { echo "could not read checks"; return 1; }

  if name=$(awk -F'\t' '$2 != "completed" { print $1; exit }' <<<"$checks") && [[ -n "$name" ]]; then
    echo "check '${name}' still running"
    return 1
  fi
  if name=$(awk -F'\t' '$3 !~ /^(success|neutral|skipped)$/ { print $1; exit }' <<<"$checks") && [[ -n "$name" ]]; then
    echo "check '${name}' did not pass"
    return 1
  fi
  IFS=',' read -ra required <<<"$FORGEGUARD_REQUIRED_CHECKS"
  for name in "${required[@]}"; do
    awk -F'\t' -v n="$name" '$1 == n { found = 1 } END { exit !found }' <<<"$checks" \
      || missing+="${missing:+, }${name}"
  done
  [[ -z "${missing:-}" ]] || { echo "required checks missing: ${missing}"; return 1; }
}

# ---------------------------------------------------------------------------
# Process one pull request.
# ---------------------------------------------------------------------------
process_pr() {
  local pr=$1 json base sha author draft labels hold findings rc reason state wanted previous
  json=$(gh api "${API}/pulls/${pr}") || { warn "cannot read #${pr}"; return 0; }

  [[ "$(jq -r .state <<<"$json")" == open ]] || return 0
  base=$(jq -r .base.ref <<<"$json")
  sha=$(jq -r .head.sha <<<"$json")
  author=$(jq -r .user.login <<<"$json")
  draft=$(jq -r .draft <<<"$json")
  labels=$(jq -r '[.labels[].name] | join(",")' <<<"$json")

  [[ " ${FORGEGUARD_BRANCHES} " == *" ${base} "* ]] \
    || { note "$pr" "skipped: base '${base}' is not managed"; return 0; }
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { warn "#${pr}: unexpected head sha"; return 0; }

  # Fetch the PR head and base as objects only — nothing is checked out.
  git fetch --quiet --no-tags origin \
    "+refs/pull/${pr}/head:refs/forgeguard/pr-${pr}" \
    "+refs/heads/${base}:refs/forgeguard/base-${pr}" \
    || { warn "#${pr}: fetch failed"; return 0; }
  [[ "$(git rev-parse "refs/forgeguard/pr-${pr}")" == "$sha" ]] \
    || { note "$pr" "skipped: head moved during the run"; return 0; }

  rc=0
  findings=$(bash "$SCANNER" "refs/forgeguard/base-${pr}" "refs/forgeguard/pr-${pr}") || rc=$?
  case "$rc" in
    0) wanted=$'success\tNo malware patterns found' ;;
    1) wanted="success"$'\t'"$(grep -c . <<<"$findings") item(s) need maintainer review; not auto-merged" ;;
    2) wanted=$'failure\tMalware pattern found; do not merge' ;;
    *) warn "#${pr}: scanner failed (exit ${rc})"; return 0 ;;
  esac

  # Scheduled runs revisit every PR, so only post when the verdict changes.
  previous=$(gh api "${API}/commits/${sha}/status" --jq \
    ".statuses[] | select(.context == \"${STATUS_CONTEXT}\") | [.state, .description] | @tsv" \
    2>/dev/null | head -n 1) || previous=""
  if [[ "$previous" != "$wanted" ]]; then
    set_status "$sha" "${wanted%%$'\t'*}" "${wanted#*$'\t'}"
    # A clean scan only rewrites an existing comment (e.g. after a fix).
    upsert_comment "$pr" "$(scan_comment "$sha" "$rc" "$findings")" "$((rc != 0))"
  fi

  case "$rc" in
    2) note "$pr" "BLOCKED by scan"; return 0 ;;
    1) note "$pr" "needs maintainer review (scan findings)"; return 0 ;;
  esac

  [[ "$draft" == false ]] || { note "$pr" "waiting: draft"; return 0; }
  IFS=',' read -ra hold <<<"$FORGEGUARD_HOLD_LABELS"
  for label in "${hold[@]}"; do
    [[ ",${labels}," == *",${label},"* ]] && { note "$pr" "held by label '${label}'"; return 0; }
  done

  reason=$(check_reviews "$pr" "$author" "$sha") || { note "$pr" "waiting: ${reason}"; return 0; }
  reason=$(check_ci "$sha") || { note "$pr" "waiting: ${reason}"; return 0; }

  # GitHub computes mergeability lazily; "unknown" is retried on the next run.
  state=$(gh api "${API}/pulls/${pr}" --jq '.mergeable_state') || state=unknown
  case "$state" in
    clean | unstable | has_hooks) ;;
    behind) note "$pr" "waiting: branch is behind ${base}"; return 0 ;;
    dirty) note "$pr" "waiting: merge conflict"; return 0 ;;
    blocked) note "$pr" "waiting: branch protection not yet satisfied"; return 0 ;;
    *) note "$pr" "waiting: mergeability is '${state}'"; return 0 ;;
  esac

  if dry; then
    note "$pr" "[dry-run] would ${FORGEGUARD_MERGE_METHOD}-merge ${sha:0:12}"
    return 0
  fi
  if gh api -X PUT "${API}/pulls/${pr}/merge" -f sha="$sha" \
    -f merge_method="$FORGEGUARD_MERGE_METHOD" >/dev/null; then
    note "$pr" "MERGED ${sha:0:12} into ${base}"
  else
    note "$pr" "merge refused by GitHub (head changed or protection not met)"
  fi
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
if [[ -n "$FORGEGUARD_PR" ]]; then
  prs=("$FORGEGUARD_PR")
else
  mapfile -t prs < <(gh api "${API}/pulls?state=open&per_page=100" --paginate --jq '.[].number') \
    || fail "cannot list open pull requests"
fi

for pr in "${prs[@]}"; do
  process_pr "$pr"
done

if [[ -n "${GITHUB_STEP_SUMMARY:-}" && ${#summary[@]} -gt 0 ]]; then
  {
    printf '### ForgeGuard\n\n| PR | Result |\n|---|---|\n'
    printf '%s\n' "${summary[@]}"
  } >>"$GITHUB_STEP_SUMMARY"
fi
