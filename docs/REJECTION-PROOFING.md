# Rejection-proofing: what must be true before applying again

AgentFlow's first application was rejected. This file is the checklist for
the next one: the likely reasons, what is fixed, what is still open, and what
would get it rejected again. It applies the lessons recorded in Soroban
Forge's `docs/REJECTION-PROOFING.md` and `docs/RESUBMISSION.md`, which went
from rejected to accepted.

Every ✅ links its evidence. Every open item says who can do it: **code**
(maintainer or agent) or **human** (only the founder).

✅ done · 🟡 partly done · ❌ not started

---

## 1. Why it was most likely rejected

1. **Overselling the headline.** The pitch said "AI agents execute them",
   but no AI model is involved anywhere: the only agent is a deterministic
   CSV calculator. This is the same mistake Forge made with six contracts
   advertised when one was real. A reviewer who checks the code sees the
   headline feature isn't there.
2. **Proof was buried.** The contract was live, but the README had no proof
   table, no read-only way to check the deployment, and no way to rebuild the
   deployed hash.
3. **No honesty documents.** Limitations were spread across the README, the
   threat model and issues, and two later commits marked browser testing as
   done when it wasn't.
4. **Hard to try.** Running anything needs Docker, Postgres, a deployment and
   a `.env`, and there is no hosted app.
5. **No design partner.** Nobody outside the project has said they would use it.

## 2. Status

| # | Item | Status | Evidence / owner |
|---|---|:---:|---|
| 1 | Honest headline | ✅ | The README says exactly what runs: a deterministic csv-aggregate agent, and a Claude-backed js-function agent that is tested with a scripted model but not yet run live ([FEATURE-STATUS](FEATURE-STATUS.md#agents-and-task-types)) |
| 1b | **A real AI-backed task type** | 🟡 | `js-function`: Claude writes the code, the API runs the client's tests in an isolated interpreter ([ADR 0006](adr/0006-js-function-task-type.md)). Built and tested end to end with a scripted model. **human + code:** run testnet scenario E with Claude credentials (`E2E_MODEL_TASK=1`) to get the live transactions, then link them in the README |
| 1c | Hidden tests | ❌ | **code.** Tests the agent can't see, so special-casing the public ones doesn't pass |
| 2 | Proof at the top of the README | ✅ | [README](../README.md#proof-at-a-glance): contract, WASM hash, build versions, every E2E transaction linked |
| 2b | Read-only verification | ✅ | `bash scripts/verify-testnet.sh`: deployed hash, on-chain config, all 8 recorded transactions, no keys |
| 2c | Reproducible build | ✅ | `--rebuild` reproduces `cbef1968…9431` with rustc 1.96.0 and stellar-cli 28.0.0; CI rebuilds and compares on every push |
| 3 | Honesty documents | ✅ | [FEATURE-STATUS](FEATURE-STATUS.md), [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md); unsupported browser-testing claims removed from README and ROADMAP |
| 4 | Randomised money tests | ✅ | [`props.rs`](../contracts/escrow/src/props.rs): conservation on every ending, a full model over random call sequences, terms fixed at funding, exact time limits; checked against planted bugs |
| 5 | USDC | ❌ | **code.** Allow testnet USDC on the deployment and use it in the E2E run ([#8](https://github.com/Meet-hybrid/agentflow/issues/8)) |
| 6 | Browser flows checked | 🟡 | **code + human.** Sign-in and browsing checked by hand 2026-10-23. Fund, review and dispute still need a click-through, ideally automated with a test signer ([#3](https://github.com/Meet-hybrid/agentflow/issues/3), [#5](https://github.com/Meet-hybrid/agentflow/issues/5)) |
| 7 | Hosted app | ❌ | **code + human.** A public testnet instance so reviewers can try it without installing anything |
| 8 | Clean-machine run | ❌ | **human.** On another machine: clone, run `bash scripts/verify-testnet.sh --rebuild`, then the quick start. Fix whatever breaks |
| 9 | **Design partner** | ❌ | **human. The most valuable item.** One project that runs one paid task through AgentFlow and says so publicly |

## 3. What would get it rejected again

- Any sentence in the README or application that claims more than
  FEATURE-STATUS shows. Before submitting, read the pitch next to
  FEATURE-STATUS line by line.
- Marking something ✅ without a test, a transaction, a hash or a command
  behind it. That includes manual checks with no recording.
- `scripts/verify-testnet.sh` failing, for example after a testnet reset. Run
  it the day you submit; if it fails, redeploy and rerun the E2E first.
- Leading with breadth (API, worker, web app, agent, contract) instead of the
  one thing that is deep and proven: the escrow and its testnet record.

## 4. Before submitting

- [ ] `bash scripts/verify-testnet.sh --rebuild` passes on the day
- [ ] Items 1b, 5 and 9 done, or the application says plainly that they are not
- [ ] FEATURE-STATUS and KNOWN-LIMITATIONS dates are current
- [ ] The application text claims nothing FEATURE-STATUS doesn't show
