# Security policy

AgentFlow handles escrowed funds. Please report vulnerabilities privately.

## Reporting

Use GitHub's **private vulnerability reporting** (Security tab → "Report a vulnerability"). Include the affected component, steps to reproduce, and impact. Do not open public issues for vulnerabilities or test against other people's tasks or funds.

We aim to acknowledge reports within 3 days and to agree on a disclosure timeline with you.

## Scope

In scope: `contracts/escrow`, `apps/api` (including the worker), `apps/web`, `agents/reference-agent`, `packages/*`, CI and repository configuration.

## Status

- Testnet only. The escrow contract has **not** been independently audited.
- The threat model and known residual risks are in [docs/security/threat-model.md](docs/security/threat-model.md).

## Repository hygiene

A sister project was hit in October 2026 by a supply-chain campaign that hid a JavaScript payload in a font file, ran it through an editor task that executed on folder open, and added an npm `preinstall` hook. This repository blocks those vectors:

- `scripts/check-repo-hygiene.sh` (CI and `pnpm hygiene`) rejects editor and devcontainer configs, font and binary files, npm lifecycle scripts and auto-run task settings.
- `.npmrc` sets `ignore-scripts=true`, and pnpm's `onlyBuiltDependencies` allowlist is empty, so no dependency runs code at install time.
- CODEOWNERS covers every file; changes require maintainer review.

Reviewers: never open an untrusted branch in an editor with workspace trust enabled, and never run installs on it with scripts enabled.
