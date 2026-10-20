# Contributor issue backlog

Real remaining work, filed as GitHub issues ([open tasks](https://github.com/Meet-hybrid/agentflow/issues?q=is%3Aissue+is%3Aopen+label%3Atask)); numbers below are the GitHub issue numbers. Each has a scope, acceptance criteria and dependencies; the effort estimate (small / medium / large) is a rough guide.

## Dependency map

```mermaid
flowchart LR
  I1[#2 agent claim test] --> I8[#11 container sandbox]
  I2[#3 web test signer] --> I3[#5 browser e2e]
  I4[#7 Wallets Kit] --> I3
  I5[#8 USDC asset]
  I6[#9 extend_deadline] --> I7[#10 extend UI]
  I9[#12 pagination]
  I10[#13 worker health]
  I11[#14 json-schema task type] --> I8
  I12[#15 multisig arbiter]
```

---

### [#2](https://github.com/Meet-hybrid/agentflow/issues/2) Test the reference agent's claim-after-timeout path — *small*
**Scope:** `ReferenceAgent.maybeClaim` has no automated test. Add one in `agents/reference-agent/test/agent.test.ts` using the fake chain's clock.
**Acceptance:** a test where the client never reviews, the review window passes, `runOnce` claims, and the task becomes `paid`; a second test that it does not claim early. **Depends on:** none.

### [#3](https://github.com/Meet-hybrid/agentflow/issues/3) Test-only signer for the web app — *medium*
**Scope:** behind `import.meta.env.MODE === "test"`, let `wallet.ts` sign with an in-memory key so browser tests can run without Freighter. Must be impossible to enable in production builds.
**Acceptance:** unit test proving the production bundle contains no test signer code; documented. **Depends on:** none.

### [#5](https://github.com/Meet-hybrid/agentflow/issues/5) Browser end-to-end tests for the web app — *large*
**Scope:** Playwright tests (API + Postgres + fake chain) for: create and fund a task, accept an application, approve a verified submission, reject with a reason, arbiter resolution.
**Acceptance:** tests run in CI; each asserts the visible status and transaction progress messages. **Depends on:** #3 (and #7 if done first).

### [#7](https://github.com/Meet-hybrid/agentflow/issues/7) Multi-wallet support with Stellar Wallets Kit — *medium*
**Scope:** replace the Freighter-only `src/wallet.ts` with Stellar Wallets Kit (Freighter, xBull, Albedo at least), keeping the network check and signer-address check.
**Acceptance:** wallet picker; wrong-network and rejected-signature errors shown; bundle size change noted in the PR. **Depends on:** none.

### [#8](https://github.com/Meet-hybrid/agentflow/issues/8) USDC (testnet) as a reward asset — *medium*
**Scope:** document allowlisting the testnet USDC Stellar Asset Contract with `set_token_allowed`; add it to `ASSETS`; show trustline requirements in the UI before funding.
**Acceptance:** an E2E variant funds and pays a task in USDC on testnet; README updated. **Depends on:** none.

### [#9](https://github.com/Meet-hybrid/agentflow/issues/9) Contract: client can extend a task's deadline — *large*
**Scope:** `extend_deadline(task_id, new_deadline)` signed by the client, only later than the current deadline, within the 90-day limit, not in terminal or disputed states; event `deadline_extended`.
**Acceptance:** contract tests for every rule, including wrong signer and shortening attempts; docs/contracts updated. **Depends on:** none.

### [#10](https://github.com/Meet-hybrid/agentflow/issues/10) API and web support for deadline extension — *medium*
**Scope:** chain-op action `extend_deadline`, reconciliation of the new deadline, and a UI control for the client.
**Acceptance:** API integration tests (permission, state, idempotency); UI shows the new deadline after confirmation. **Depends on:** #9.

### [#11](https://github.com/Meet-hybrid/agentflow/issues/11) Container-based executor sandbox with network control — *large*
**Scope:** optional executor isolation in a rootless container (no network by default, read-only filesystem, CPU/memory limits), selectable per executor, keeping the current process sandbox as the default.
**Acceptance:** escape probes (write, spawn, network) fail; timeout kills the container; documented. **Depends on:** #2.

### [#12](https://github.com/Meet-hybrid/agentflow/issues/12) Cursor pagination for task lists and history — *medium*
**Scope:** replace `limit`-only listing with cursor pagination on `GET /tasks` and the history sub-lists; update the web marketplace.
**Acceptance:** stable ordering under concurrent inserts (test); OpenAPI updated. **Depends on:** none.

### [#13](https://github.com/Meet-hybrid/agentflow/issues/13) Worker health and metrics — *small*
**Scope:** record the worker's last successful iteration, indexer cursor ledger and count of `submitted` ops older than 10 minutes; expose them on `GET /health`.
**Acceptance:** tests for healthy and stale states. **Depends on:** none.

### [#14](https://github.com/Meet-hybrid/agentflow/issues/14) New deterministic task type: JSON Schema validation — *large*
**Scope:** `json-schema-validate`: validate a set of JSON documents against a client-supplied schema (bounded size), producing per-document results; verifier recomputes.
**Acceptance:** executor, verifier, schema limits, sandbox execution and tests mirroring `csv-aggregate`. **Depends on:** none (#11 recommended).

### [#15](https://github.com/Meet-hybrid/agentflow/issues/15) Multisig arbiter — *large*
**Scope:** deploy the arbiter as a Stellar multisig account (e.g. 2-of-3) and support collecting multiple signatures for `resolve` in the API and UI.
**Acceptance:** testnet demonstration where one signature is insufficient and two succeed; threat model updated. **Depends on:** none.
