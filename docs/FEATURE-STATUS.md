# Feature status

What AgentFlow does today, part by part, and how each claim can be checked.
The rule for this file: every ✅ points to a test, a transaction, a hash or a
command. If it can't, it is not ✅.

| Mark | Meaning |
|---|---|
| ✅ | Implemented and checked by automated tests in CI, or by real testnet transactions anyone can look up |
| 🟡 | Implemented, but only part of it is checked, or only by hand |
| ❌ | Not built yet |

**Last checked:** 2026-11-27, against the testnet deployment in
[`deployments/testnet.json`](../deployments/testnet.json). Re-check the
deployment yourself with `bash scripts/verify-testnet.sh` (read-only, no keys).

---

## Escrow contract (`contracts/escrow`), deployed on testnet

Contract [`CBT4QNZ7…YQKH`](https://stellar.expert/explorer/testnet/contract/CBT4QNZ7V3FYJIYYA26Y3OJZZL42RMDDX6IEAMDTDMGSGCDNYIN3YQKH),
WASM sha256 `cbef1968…9431`, which a local build reproduces (see the
[README](../README.md#proof-at-a-glance)).

| Function | Status | Who signs | Money movement | Evidence |
|---|:---:|---|---|---|
| `__constructor` | ✅ | deployer | none | `get_config` on testnet matches `deployments/testnet.json` (verify script, check 2) |
| `fund` | ✅ | client | client → contract, real SAC transfer | testnet tx [`625fee48…`](https://stellar.expert/explorer/testnet/tx/625fee48d0ceb6010f0a672ab6b491cfa663cffa36d6243b4d38b9efe67e96e2); `test.rs`; P1, P2 |
| `assign` | ✅ | client | none | testnet tx [`09739eec…`](https://stellar.expert/explorer/testnet/tx/09739eec80f2aaa1fe73b624bcd29d310c15cd5132aebf59a8270afb2cb9fa39); P2, P4 |
| `submit` | ✅ | payee | none (stores the evidence hash) | testnet tx [`e72c14b2…`](https://stellar.expert/explorer/testnet/tx/e72c14b2da7d1059f8aff92a8505566f57cc04b5a074b3eac66eca8d7fe69e31); P2, P4 |
| `approve` | ✅ | client | contract → payee, full amount | testnet tx [`cbfff682…`](https://stellar.expert/explorer/testnet/tx/cbfff68279b20a803b66a472f8e6583466efb0129b6c67c50727100a67e88b2f) (exactly 10 XLM paid); P1, P2 |
| `reject` | ✅ | client | none | testnet tx [`88b58633…`](https://stellar.expert/explorer/testnet/tx/88b58633eafba2e019badaaaa7860295765529299416197a500d8bb3155297db); P2, P4 |
| `claim` (review timeout) | ✅ | payee | contract → payee, full amount | `test.rs`; P1, P2, P4. Not yet run on testnet |
| `abandon` | ✅ | payee | none | `test.rs`; P2. Not yet run on testnet |
| `refund` | ✅ | client | contract → client, full amount | testnet tx [`21d1856f…`](https://stellar.expert/explorer/testnet/tx/21d1856f68a68f2db25a03a0b0a73efb4caef4ef28da998c4830d27abc289a90); a refund signed by the agent **failed on-chain** as it should: [`a36cf269…`](https://stellar.expert/explorer/testnet/tx/a36cf2692a5f9d9cc13624e2fbe7879cfe1003e99101e7e241742c4e183a743e); P1, P2, P4 |
| `dispute` | ✅ | client or payee | none (freezes the escrow) | E2E scenario D; P2 (outsiders always refused) |
| `resolve` | ✅ | the task's arbiter | contract → payee and client, split in basis points | testnet tx [`b7e4b3d1…`](https://stellar.expert/explorer/testnet/tx/b7e4b3d1cf77331353c7ddc7da7f15a0dff17db48ad9f5993fbed129ae23b168) (2 XLM each); P1, P2 |
| `set_arbiter`, `set_review_window`, `set_token_allowed` | ✅ | admin | none, and cannot touch funded tasks | `test.rs`; P3 |
| `get_task`, `get_config`, `is_token_allowed`, `bump` | ✅ | anyone | none | `test.rs`; P2 compares `get_task` to the model after every call |
| Events (`Funded` … `Resolved`, task id as topic) | 🟡 | | | Read by the API worker's event indexer during the testnet E2E run. No contract test checks event contents yet |
| Tokens | 🟡 | | | Allowlist works with any SAC; **only XLM is allowed on the deployment**. USDC is not set up ([#8](https://github.com/Meet-hybrid/agentflow/issues/8)) |
| `extend_deadline` | ❌ | | | [#9](https://github.com/Meet-hybrid/agentflow/issues/9) |
| Multisig arbiter | ❌ | | | [#15](https://github.com/Meet-hybrid/agentflow/issues/15) |

**Tests: 45.** 41 hand-written tests in
[`test.rs`](../contracts/escrow/src/test.rs) (lifecycle, every contract error,
who must sign, time boundaries) and 4 randomised properties in
[`props.rs`](../contracts/escrow/src/props.rs), run against a real Stellar
Asset Contract:

- **P1** every way a task can end leaves the contract holding zero and pays
  out exactly the amount funded, and an ended task can't pay twice;
- **P2** random sequences of up to 80 calls across 3 tasks, checked against a
  model of the rules after every call: exact success or error, exact balance
  of every account, contract balance equal to the open tasks, stored task
  equal to the model;
- **P3** changing the arbiter or review window never affects tasks already funded;
- **P4** every time limit refuses one second early and allows exactly on time.

The suite was checked by planting three off-by-one bugs and a state-machine
bug in the contract; each one made a property fail.

## Off-chain services

| Part | Status | Evidence |
|---|:---:|---|
| SEP-10 wallet sign-in | ✅ | `apps/api/test`; testnet E2E (client and operator sign in) |
| Agent registration with an accountable operator, hashed API keys, key rotation | ✅ | `apps/api/test`; testnet E2E |
| Task creation, discovery, filtering, applications, assignment | ✅ | `apps/api/test`; testnet E2E |
| Prepare → sign → submit → confirm, idempotency, one transaction in flight per task | ✅ | `apps/api/test` with a stand-in contract that builds and checks real Stellar transactions; testnet E2E |
| Reconciliation from chain state | ✅ | testnet E2E scenario C: a refund sent around the API was picked up from the chain |
| Submission verification by recomputing the result | ✅ | `packages/shared/test`; testnet E2E scenario A |
| Reference agent: discover, evaluate, apply, execute in a sandbox, submit, dispute an unfair rejection | ✅ | `agents/reference-agent/test`; testnet E2E scenarios A and D |
| Reference agent: claim after the review timeout | 🟡 | Code exists; no automated test yet ([#2](https://github.com/Meet-hybrid/agentflow/issues/2)) |
| Sandbox | 🟡 | Node permission model: no file writes, child processes or environment access. **Network access is not restricted** ([#11](https://github.com/Meet-hybrid/agentflow/issues/11)) |

## Agents and task types

| Part | Status | Evidence |
|---|:---:|---|
| `csv-aggregate` task type (count/sum/avg/min/max over an inline CSV, exact decimals) | ✅ | `packages/shared/test`; testnet E2E |
| The reference agent | ✅ | It is a **deterministic program, not an AI model**. It shows the full workflow with an agent whose result can be checked exactly |
| Agents backed by an AI model (LLM) | ❌ | Not built. The executor interface is ready for one ([docs/agents](agents/README.md#executor-adapter)) |
| Code tasks verified by running a test suite | ❌ | Planned (ROADMAP M2) |
| Any other task type | ❌ | [#14](https://github.com/Meet-hybrid/agentflow/issues/14) |

## Web app (`apps/web`)

| Part | Status | Evidence |
|---|:---:|---|
| Builds and type-checks | ✅ | CI |
| Freighter connection, sign-in, marketplace, agents and dashboard pages | 🟡 | Checked by hand in a browser on testnet on 2026-10-23 (Freighter unlock, connection approval, the sign-in signature, marketplace and agents pages). No recording in the repo |
| Funding, review, rejection and dispute **from the browser** | 🟡 | The pages call the same API paths the testnet E2E run exercises, but nobody has yet clicked through them with Freighter |
| Automated browser tests | ❌ | [#5](https://github.com/Meet-hybrid/agentflow/issues/5), which needs a test-only signer ([#3](https://github.com/Meet-hybrid/agentflow/issues/3)) |
| Hosted instance | ❌ | Runs locally only |

## Operations

| Part | Status | Evidence |
|---|:---:|---|
| Testnet deployment | ✅ | `bash scripts/verify-testnet.sh` |
| Reproducible contract build | ✅ | `bash scripts/verify-testnet.sh --rebuild`, and a CI step that rebuilds and compares the hash |
| Mainnet | ❌ | Not planned until after an independent audit |
| Independent security audit | ❌ | See [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md) |
