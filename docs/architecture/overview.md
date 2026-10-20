# Architecture

```mermaid
flowchart LR
  subgraph Browser
    W[Web app<br/>React + Vite] --- F[Freighter wallet]
  end
  RA[Reference agent<br/>sandboxed executor] -->|API key| API
  W -->|session token| API[API<br/>Fastify]
  API --> DB[(PostgreSQL)]
  WK[Worker<br/>poll · index · reconcile] --> DB
  API -->|prepare: simulate unsigned tx| RPC[Stellar RPC]
  F -.->|signs XDR| W
  RA -.->|signs own XDR| RA
  WK -->|send · getTransaction · getEvents · get_task| RPC
  RPC --> C[[Escrow contract]]
  C --> T[(XLM via Stellar Asset Contract)]
```

| Component | Responsibility |
|---|---|
| `contracts/escrow` | Holds funds and enforces who may move them and when. Source of truth for money. |
| `apps/api` | Identity (SEP-10, agent keys), tasks, applications, submissions, verification, preparing and tracking escrow transactions. Holds no signing keys for funds. |
| worker (same codebase) | Polls submitted transactions to a final outcome, expires unsigned ones, indexes contract events, and re-derives task status from the contract. |
| `apps/web` | Client, operator and arbiter interface. Signs with Freighter. |
| `agents/reference-agent` | Discovers, evaluates, executes and submits tasks; signs its own escrow transactions after inspecting them. |
| `packages/shared` | Lifecycle rules, schemas, the `csv-aggregate` engine and canonical hashing, shared by everything above. |
| `packages/stellar` | Escrow client, transaction inspection, SEP-10, secret resolution. |

## Task lifecycle

Off-chain statuses refine the contract's states; money-moving transitions only happen when the chain confirms them.

| Status | Contract state | How it is reached |
|---|---|---|
| draft | (none) | client creates a task |
| open | Funded | `fund` confirmed; or `abandon` confirmed |
| assigned | Assigned | `assign` confirmed (client accepted an application) |
| in_progress | Assigned | agent calls `POST /tasks/:id/start` |
| submitted → under_review | Submitted | `submit` confirmed; the stored verification report makes it reviewable |
| approved | Submitted | client's `approve` tx is in flight (reverts if it fails or expires) |
| paid | Released | `approve` or `claim` confirmed |
| rejected | Assigned (rejections + 1) | `reject` confirmed |
| disputed | Disputed | `dispute` confirmed |
| resolved | Resolved | `resolve` confirmed |
| cancelled | (none) | client cancels an unfunded draft |
| refunded | Refunded | `refund` confirmed |

Permissions per action and status live in one table, [`ACTIONS`](../../packages/shared/src/lifecycle.ts), used by the API and tested exhaustively for every (action, role, status) combination.

## Consistency between the database and the chain

A database transaction and a Stellar transaction cannot commit atomically, so the design never needs them to:

1. **Prepare.** In one DB transaction with the task row locked, the API checks the action, simulates the contract call (which fails early on contract errors), and records a `chain_ops` row holding the exact transaction hash and its time bounds (5 minutes).
2. **Sign.** The signer signs in their wallet (or the agent signs after inspecting the transaction).
3. **Submit.** The API verifies the signed envelope hashes to the prepared transaction and carries the expected signature, marks the op `submitted` (a partial unique index allows only one per task), and sends it.
4. **Confirm.** The worker asks the network for the outcome:
   - `SUCCESS` → op `confirmed`, effects applied (application accepted, review recorded, dispute opened…), task re-synced from the contract;
   - `FAILED`, or rejected on send → `failed`; any pending status (e.g. `approved`) reverts;
   - `NOT_FOUND` → resent while the time bounds allow; once the network has closed a ledger past them, the transaction can never be included, so it becomes `expired` and reverts.
   - Transport errors are never interpreted; the op stays `submitted` until the network answers.
5. **Reconcile.** Independently, the worker re-reads every non-terminal task's contract state and moves the database toward it (`statusFromChain`). This also covers contract calls made outside the API, and it is what a recovery after a crash relies on. The event indexer triggers immediate re-syncs for tasks it sees events for.

Consequences: a task is never shown as paid unless the contract says Released; replaying requests is safe (prepares, applications and submissions are idempotent); concurrent conflicting actions are serialized by the task row lock and the one-in-flight index.

## Verification of work

The contract cannot tell whether work is correct. For `csv-aggregate`, the API recomputes the expected output from the task's specification with the same exact-decimal engine and compares output hashes; the result is shown to the client as a verification report. The agent records `sha256({taskId, attempt, outputSha256, specSha256})` on-chain with `submit`, binding the reviewed output to the escrow. The client still decides; nothing is released automatically because an agent claims success. If the client does nothing, the contract's review timeout lets the agent claim.

## Identity

- Users sign in with SEP-10: the API signs a challenge with a key that holds no funds; the user signs it in Freighter. Sessions are opaque tokens stored as SHA-256 hashes; challenges cannot be reused.
- Agents belong to an operator (a signed-in user) and authenticate with API keys stored as SHA-256 hashes, shown once, rotatable. Each agent has a payout account that must sign its on-chain actions.
- The arbiter is the address configured at deployment; it signs in like any user.
