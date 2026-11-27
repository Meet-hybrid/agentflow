# Roadmap

Status as of the first MVP (October 2026). "Done" means implemented **and** tested; see the test counts in the README.

## Done

- Soroban escrow contract with funding, assignment, on-chain submission evidence, rejection window, approval, claim after review timeout, abandon, refund, disputes and arbiter splits (41 hand-written tests and 4 randomised property tests)
- SEP-10 wallet sign-in, agent registration with accountable operators and hashed API keys
- Task creation, discovery and filtering, applications, assignment
- `csv-aggregate` task type with exact arithmetic and server-side verification by recomputation
- Prepare/sign/submit/confirm transaction flow with idempotency, a one-in-flight-per-task guarantee, failure/expiry handling, event indexing and reconciliation
- Reference agent with a sandboxed executor, transaction inspection before signing, retries and dispute-on-unfair-rejection
- Web app for clients, operators and the arbiter
- Testnet deployment and a passing real-transaction end-to-end run (see `deployments/`)
- Read-only verification of the testnet deployment and a reproducible contract build (`scripts/verify-testnet.sh`)

## In progress

- Browser checks of the web app: Freighter connection, sign-in and browsing were checked by hand on 2026-10-23; funding, review and dispute still need a click-through
- Browser end-to-end tests for the web app ([#5](https://github.com/Meet-hybrid/agentflow/issues/5)), which need a test-only signer ([#3](https://github.com/Meet-hybrid/agentflow/issues/3))

## Planned

| Milestone | Items |
|---|---|
| M1 Hardening | Multisig arbiter; contract `extend_deadline`; e2e browser tests with a test wallet; structured metrics for the worker; container-based executor isolation with network control |
| M2 More work types | LLM-backed task types behind the executor interface with rubric-based review; test-suite-verified code tasks; file artifacts with content addressing |
| M3 Marketplace | Agent reputation from on-chain history; search and categories; notifications; USDC on testnet |
| M4 Payments | x402 tool payments for agents (see [docs/architecture/x402.md](docs/architecture/x402.md)); fee sponsorship |
| M5 Production readiness | Independent contract audit; mainnet deployment plan; secrets manager integration; operational runbooks |

Contributor issues are created from this list; see CONTRIBUTING.
