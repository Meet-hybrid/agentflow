# Development

Toolchain: Node ≥ 22.12 (runs TypeScript directly; `tsc` is only used to type-check), pnpm 9, Rust stable with the `wasm32v1-none` target, Stellar CLI ≥ 28, Docker.

```bash
pnpm install                 # no dependency install scripts run (see .npmrc)
bash scripts/db.sh up        # Postgres 16 on 127.0.0.1:55432 (databases: agentflow, agentflow_test)
```

| Command | What it does |
|---|---|
| `pnpm lint` | Biome lint + format check |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm test` | Vitest in every package (API and agent tests need the DB) |
| `pnpm hygiene` | repository hygiene check (also in CI) |
| `pnpm contract:test` | contract unit tests |
| `pnpm contract:build` | WASM build |
| `pnpm db:migrate` | apply SQL migrations (the API also migrates on start) |

Database migrations live in `apps/api/src/db/migrations/` and are applied in filename order inside an advisory lock. Add a new numbered file; never edit an applied one.

The API and agent tests use `apps/api/test/fake-chain.ts`, an in-memory stand-in for the escrow contract that builds and verifies real transactions. It exists to test backend logic; it is not evidence of Stellar integration.
