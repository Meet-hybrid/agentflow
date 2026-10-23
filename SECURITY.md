# Security policy

AgentFlow handles escrowed funds. Please report vulnerabilities privately.

## Reporting

Use GitHub's **private vulnerability reporting** (Security tab → "Report a vulnerability"). Include the affected component, steps to reproduce, and impact. Do not open public issues for vulnerabilities or test against other people's tasks or funds.

We aim to acknowledge reports within 3 days and to agree on a disclosure timeline with you.

## Scope

In scope: `contracts/escrow`, `apps/api` (including the worker), `apps/web`, `agents/reference-agent`, `packages/*`, CI and repository configuration.

## Status

- Testnet only; not safe for real funds. Neither the escrow contract nor the off-chain services have been independently audited.
- Disputes are decided by a **single arbiter key** fixed per task at funding time. Its holder can split disputed funds arbitrarily, and a lost key or an inactive arbiter leaves disputed funds locked. Undisputed tasks are unaffected.
- The threat model and known residual risks are in [docs/security/threat-model.md](docs/security/threat-model.md).

## Repository hygiene

A sister project was hit in October 2026 by a supply-chain campaign that hid a JavaScript payload in a font file, ran it through an editor task that executed on folder open, and added an npm `preinstall` hook. This repository blocks those vectors:

- `scripts/check-repo-hygiene.sh` (CI and `pnpm hygiene`) rejects editor and devcontainer configs, font and binary files, npm lifecycle scripts and auto-run task settings.
- `.npmrc` sets `ignore-scripts=true`, and pnpm's `onlyBuiltDependencies` allowlist is empty, so no dependency runs code at install time.
- CODEOWNERS covers every file, and names CI, scripts, editor configs, package and lock files, and the contract's dependency manifests explicitly.
- `main` is protected: pull requests need an approving review (stale approvals are dismissed on new pushes), the `Repo hygiene`, `Contract`, `TypeScript` and `Security Audit` checks must pass on an up-to-date branch, review conversations must be resolved, history stays linear, and force-pushes and branch deletion are blocked.
- [FlowGuard](docs/FLOWGUARD.md) scans every pull request for supply-chain malware patterns (hidden payloads, Trojan Source characters, decode-and-execute code, non-registry npm, pnpm or Cargo sources, binaries, build-time code) and merges only pull requests that a maintainer approved, that are green, and that scan clean. It reads pull requests as git objects and never runs their code.
- The **Security Audit** workflow runs on every pull request and weekly: RustSec advisories (`cargo audit`) and the policy in `contracts/deny.toml` (crates.io-only sources, permissive licenses, no wildcard versions or yanked crates) for the contract, and `pnpm audit` for the TypeScript workspaces. Dependabot opens version and security updates; secret scanning with push protection is enabled.

Reviewers: never open an untrusted branch in an editor with workspace trust enabled, and never run installs on it with scripts enabled.
