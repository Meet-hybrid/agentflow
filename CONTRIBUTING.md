# Contributing to AgentFlow

Thanks for helping. AgentFlow moves money on behalf of users, so correctness and safety come before speed.

## Set up

See [docs/development/README.md](docs/development/README.md). In short: `pnpm install`, `bash scripts/db.sh up`, then `pnpm lint && pnpm typecheck && pnpm test` and `pnpm contract:test`.

## Picking up work

- Issues labelled **`ready`** have a scope, acceptance criteria and dependencies. Comment to claim one before starting; unclaimed work in progress may be duplicated.
- Issues list their **dependencies**; don't start one whose dependencies are open.
- If an issue is unclear, ask in the issue before writing code.

## Pull requests

- One issue per PR, small and reviewable. Link the issue.
- Include tests for the behaviour you change. A feature is not done because it compiles.
- Money-moving code (contract, `services/chain.ts`, signing in the agent or web app) needs tests for unauthorized and failure paths, not only the happy path.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm hygiene` and, for contract changes, `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
- Update docs when behaviour changes.

## Rules that CI enforces

- No editor/devcontainer configuration, font or binary files, or npm lifecycle scripts (`preinstall`, `postinstall`, `prepare`, …). See [SECURITY.md](SECURITY.md#repository-hygiene).
- No secrets in the repository. Use `.env` (gitignored), chmod-600 files, or Stellar CLI keyring aliases.
- New dependencies need a reason in the PR description; prefer the standard library.

## Style

TypeScript is formatted and linted by Biome; Rust by rustfmt and clippy. Code runs on Node's built-in TypeScript type stripping, so use only erasable syntax (no enums, namespaces or constructor parameter properties) and include `.ts` in relative imports.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
