# Threat model

Scope: the escrow contract, API and worker, web app, reference agent and repository. Assets: escrowed funds, users' signing authority, agent payout keys, task data integrity, platform availability.

| # | Threat | Mitigation | Where |
|---|---|---|---|
| 1 | Someone other than the client releases or refunds funds | Every money-moving function `require_auth`s the named party; tested with wrong signers | contract |
| 2 | Double payment (approve twice, approve then claim, release then refund) | Terminal states set before transfer; tests for every second payout path | contract |
| 3 | Replaying a funding or reusing a task id | Task ids can be funded once ever | contract |
| 4 | Admin changes the arbiter or review window for funds already escrowed | Both are snapshotted into the task at funding | contract |
| 5 | Malicious token contract | Token allowlist set by admin; testnet allows only native XLM's SAC | contract |
| 6 | Client ghosts the agent after submission | `claim` after the review window | contract |
| 7 | Client rejects late, then refunds before the agent can respond | Reject only within the review window; refund after a rejection waits one review window | contract |
| 8 | API (or an attacker in the middle) swaps the transaction a user signs | API accepts only an envelope whose hash equals the prepared tx; wallets display what is signed; agents decode and check contract, function, task id, source and fee before signing | API, agent |
| 9 | DB marks a task paid without a payment | Status changes to paid/refunded/resolved only from confirmed chain state; failed, expired and unknown outcomes never do | API/worker |
| 10 | Ambiguous submission (timeout, TRY_AGAIN_LATER) | Op stays `submitted`; resent while valid; marked expired only after the network passes the tx's max time | worker |
| 11 | Concurrent conflicting actions (approve vs dispute; two accepts) | Row lock per task, one in-flight op per task (unique index), superseding of unsigned ops, unique accepted application | API, DB |
| 12 | Duplicate requests | Idempotent prepares, applications and submissions (per-agent idempotency keys) | API |
| 13 | Contract called directly, bypassing the API | Reconciliation re-derives status from `get_task`; event indexer | worker |
| 14 | Session or API key theft from the database | Only SHA-256 hashes stored; keys shown once; rotation revokes old keys | API |
| 15 | SEP-10 challenge replay | Challenges expire (5 min) and are single-use | API |
| 16 | Malicious task input attacking agents | Tasks are data, never code; strict schema and size limits; agent executes in a separate Node process with the permission model (no writes, no spawn, read-only code dir), empty environment, heap cap and timeout | shared, agent |
| 17 | Malicious agent output attacking clients | Output schema and size limits; rendered as text only; hashes verified | API, web |
| 18 | API abuse | Global and auth-specific rate limits, 1 MiB body limit, CORS restricted to the web origin, security headers | API |
| 19 | Secrets leaking | No secrets in the repo (`.gitignore`, hygiene check); keys loaded from the OS keyring via Stellar CLI aliases or chmod-600 files; logs redact auth headers | repo, ops |
| 20 | Supply-chain attack through a contributor PR (as in the October 2026 campaign that hit a sister project) | `.npmrc` `ignore-scripts`, pnpm `onlyBuiltDependencies: []`, CI hygiene check rejecting editor auto-run configs, binaries and lifecycle scripts, CODEOWNERS on all files | repo |

## Residual risks

- The contract is **not audited**.
- The arbiter is a single key; it can decide disputed funds and could stall them.
- Node 22's permission model does not restrict network access from the sandbox; the shipped executor never opens connections, but this is not enforced.
- Wallet users must still read what they sign; Freighter shows the contract call.
- SEP-10 accepts only an account's master key (no multisig accounts).
- The SEP-10 signing key, if stolen, would allow forging sessions (not moving funds). Keep it in the keyring or a secrets manager and rotate on suspicion.
