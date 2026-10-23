# FlowReview

**FlowReview is an AgentFlow automation tool. It is NOT an official Drips or
Stellar bot.**

FlowReview helps maintainers review pull requests faster. After CI finishes on
a pull request, it posts **one** comment (updated in place on every push) that
says where to look closely before approving, plus an optional AI-written
summary.

FlowReview is **advisory only**. It never approves, never merges, and is not a
CODEOWNER. Required maintainer review, [FlowGuard](FLOWGUARD.md) and branch
protection are unchanged: a maintainer still reads the change and approves it,
and FlowGuard merges only after that approval.

```
PR opened / updated -> CI -> FlowBot (CI status) + FlowReview (where to look)
                                         |
                       maintainer reviews and approves
                                         |
                      FlowGuard scans and merges the approved head
```

## What it checks

Rules run in `scripts/flowreview/analyze.py`. Like FlowGuard they read git
objects only and never build or run pull-request code.

| Risk | Rule |
| --- | --- |
| 🔴 high | `require_auth` removed from contract code |
| 🔴 high | contract upgrade path added (`update_current_contract_wasm`) |
| 🔴 high | Cargo build script (`build.rs` at a crate root, or `build = "…"`) |
| 🔴 high | changes under `.github/`, `scripts/`, `.vscode/`, `.devcontainer/`, or shell/batch files |
| 🔴 high | dependency from git, another registry, or a path outside the repository |
| 🟠 medium | new or changed dependency (normal, dev or build) in `Cargo.toml` / `package.json` |
| 🟠 medium | `unsafe`, `.unwrap()`, `.expect(` or `panic!` added to contract code (test-only code excluded) |
| 🟠 medium | contract code changed with no test change |
| 🟠 medium | more than 800 changed lines |

Contract code means `.rs` files in crates that build a `cdylib`. Files under
`tests/`, `#[cfg(test)] mod …;` modules and `*.test.ts`-style files count as
tests.

## AI summary (optional)

When the repository has an `ANTHROPIC_API_KEY` secret, FlowReview also sends
the PR title, description, diff and rule findings to the Claude API
(`claude-opus-5-5`) and adds a short summary: what the change does, which parts
deserve a close read, and whether the diff matches the description. Without the
secret, the comment says the AI summary is off and everything else still works.

**Treat the summary as a hint, not a verdict.** The PR author controls the text
the model reads and may try to steer it. To limit that:

- the model is told the PR content is untrusted data, and never approves;
- @-mentions, images, links and HTML are neutralized before posting;
- the comment labels the section as AI-written;
- a refusal or API error just leaves the summary out, with a warning in the
  workflow log; it never fails the PR.

### Setup

1. Create an API key at [console.anthropic.com](https://console.anthropic.com)
   (Settings → API Keys). A spend limit on the workspace is recommended.
2. In this repository: **Settings → Secrets and variables → Actions → New
   repository secret**, name `ANTHROPIC_API_KEY`, paste the key.
3. The next CI run on a pull request includes the summary. To refresh a PR
   now: **Actions → FlowReview → Run workflow**, with the PR's CI run ID.

Cost: one request per CI run on a pull request; diffs over 200 KB are cut and
the summary says so. Set `FLOWREVIEW_MODEL` in the workflow to use another
model.

## Security model

- Runs on `workflow_run` after `CI`, so fork pull requests get the same review.
- Checks out the **default branch only**, without persisted credentials; the
  pull request head is fetched as git objects and never checked out, built or
  executed.
- Permissions: `contents: read`, `actions: read`, `pull-requests: write`
  (comment only). The API key is exposed only to the review step.
- Every value reaching an API path or git refspec is validated first.

## Testing

```bash
bash scripts/flowreview/test-review.sh
```

The regression tests build a throwaway repository with one branch per rule,
and check the AI summary's sanitizing and failure handling against saved API
responses (no network, no key). They run in CI next to FlowGuard's tests.

To preview a comment for a real PR without posting it:

```bash
GH_TOKEN=$(gh auth token) FLOWREVIEW_REPO=Meet-hybrid/agentflow \
  FLOWREVIEW_RUN_ID=<ci run id> FLOWREVIEW_DRY_RUN=1 \
  bash scripts/flowreview/review.sh
```
