# FlowGuard

**FlowGuard is a repository automation tool, ported from
[Soroban Forge](https://github.com/Meet-hybrid/soroban-forge). It is NOT an
official Drips or Stellar bot.** It runs entirely on GitHub Actions with the
repository's `GITHUB_TOKEN`; there is no separate account or GitHub App.

FlowGuard scans every open pull request for supply-chain malware patterns and
merges a pull request once it is approved, green and clean. It complements the
whole-tree checks in `scripts/check-repo-hygiene.sh`, which CI runs on every push.

## When FlowGuard merges

A pull request is merged only when **all** of these hold:

1. **The scan is clean.** Any finding, of either level, means a maintainer
   merges by hand.
2. **CI is green.** Every check on the head commit has passed (Vercel previews
   are ignored), and `Repo hygiene`, `Contract`, `TypeScript` and
   `Security Audit` exist.
3. **A maintainer approved the current head.** At least one user with write
   access approved the exact head commit, the author's own approval does not
   count, and nobody's latest review requests changes. A new push resets this.
4. **Nothing is holding it.** The PR is not a draft, targets `main`, and has
   neither the `do-not-merge` nor the `flowguard:hold` label.
5. **GitHub agrees.** The PR is mergeable, not behind its base and not blocked
   by branch protection.

The merge is a squash merge pinned to the scanned head SHA. If anyone pushes
after the scan, GitHub rejects the merge and the next run starts over.

FlowGuard never approves, never bypasses branch protection, and never updates
or rebases a contributor's branch.

## What the scan looks for

`scripts/flowguard/scan-pr.sh BASE HEAD` checks the PR's changes since its
merge base. It reports paths and line numbers only, never file content.

**BLOCK**: malware patterns. Status `FlowGuard / malware-scan` fails:

- anything `scripts/check-repo-hygiene.sh` rejects, checked over the whole head tree:
  editor and devcontainer configs, font and binary files, npm lifecycle scripts,
  and auto-run task settings;
- binary files other than images, symlinks and git submodules;
- Trojan Source characters (bidirectional controls, zero-width characters);
- code hidden after a long run of whitespace;
- `eval`/`Function` applied to `atob`, `Buffer.from` or similar decoders;
- npm packages resolved from outside `registry.npmjs.org`, installed from git or
  URL sources, or pnpm lock entries resolved from a tarball URL or git repository
  (`workspace:` and `file:` dependencies are allowed);
- Cargo dependencies from git or alternative registries.

**REVIEW**: sensitive but legitimate changes. The status passes, but FlowGuard
leaves the merge to a maintainer:

- `.github/` (workflows, CODEOWNERS), `scripts/`, Makefiles, `.cargo/` config,
  toolchain files and `.gitattributes`;
- Cargo build scripts, build dependencies and proc macros (code that runs at build time);
- `child_process`, `eval` or `new Function` in JavaScript or TypeScript;
- long hex-escaped strings, base64 blobs and lines over 2000 characters
  (Soroban contract-spec entries, which start with `AAAA`, are exempt);
- `curl … | sh`, new executable files, images and files over 1 MiB.

Any change to FlowGuard itself falls under REVIEW, so the bot can never merge
a change to its own rules.

When a scan finds something, FlowGuard posts one sticky comment on the PR
listing the findings, and updates it in place on later runs.

## How it runs

`.github/workflows/flowguard.yml` runs when CI completes on a pull request,
every 30 minutes (to pick up approvals), and on demand from the Actions tab.
The manual run takes an optional PR number and a dry-run switch.

The job checks out the **default branch** and runs the scanner from there. Pull
request heads are fetched as git objects (`refs/pull/N/head`) and only read with
`git diff`, `git grep` and `git cat-file`, with external diff drivers and
textconv disabled. Nothing from a pull request is checked out, installed, built
or executed, so a PR cannot change the rules it is judged by.

## Running it locally

```bash
# Scan a branch against main.
bash scripts/flowguard/scan-pr.sh origin/main my-branch

# Scanner regression tests (also run in CI).
bash scripts/flowguard/test-scan.sh

# Report what the bot would do, without posting or merging.
GH_TOKEN=$(gh auth token) FLOWGUARD_REPO=Meet-hybrid/agentflow \
  FLOWGUARD_DRY_RUN=1 FLOWGUARD_BRANCHES=main \
  FLOWGUARD_REQUIRED_CHECKS="Repo hygiene,Contract,TypeScript,Security Audit" \
  bash scripts/flowguard/merge.sh
```

The approval check reads collaborator permissions, which needs a token with push
access to the repository.

## Known limitations

- Merges made with `GITHUB_TOKEN` do not trigger further workflows, so CI does
  not re-run on `main` after a FlowGuard merge. Switch the workflow to a GitHub
  App token if that matters.
- PRs that are behind `main` (branch protection requires up-to-date branches)
  wait until the author, or a maintainer, updates them.
- With a single maintainer, a maintainer's own PRs can never be approved by
  someone else, so FlowGuard does not merge them; the maintainer merges them by
  hand.
- The scan is pattern-based. It catches known supply-chain campaigns and common
  obfuscation, not every possible attack, so it supplements human review rather
  than replacing it.
