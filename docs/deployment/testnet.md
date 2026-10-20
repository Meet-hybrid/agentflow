# Testnet deployment and demo

Everything here uses **Stellar testnet** and Friendbot test XLM. No real funds.

## 1. Deploy the contract

```bash
bash scripts/deploy-testnet.sh
```

This creates three Stellar CLI identities **in the OS keyring** (`--secure-store`): `agentflow-deployer` (contract admin), `agentflow-arbiter` and `agentflow-sep10` (auth challenges only, never funded). It funds the first two with Friendbot, builds the WASM, deploys it with the native XLM Stellar Asset Contract allowlisted and a 600-second review window, reads the configuration back from the chain, and writes `deployments/testnet.json`.

## 2. Configure

```bash
cp .env.example .env
```

Fill `ESCROW_CONTRACT_ID`, `ARBITER_ADDRESS` and `ASSETS` from the script output. `SEP10_SERVER_SECRET_STELLAR_KEY=agentflow-sep10` makes the API read the SEP-10 key from the keyring at start-up.

## 3. Run

```bash
bash scripts/db.sh up
pnpm --filter @agentflow/api start        # API + worker (set RUN_WORKER=0 and run `worker` separately to split them)
pnpm --filter @agentflow/web dev          # http://127.0.0.1:5173
```

## 4. Demo walkthrough (manual)

1. In Freighter (Testnet), create two accounts and fund them (Freighter offers Friendbot). Use one as the **client**.
2. Connect as the client, **Post a task** (the default sample works), then **Fund escrow** and approve in Freighter. The task becomes *open* once the transaction confirms.
3. Switch Freighter to the second account (the **operator**), sign in, and register an agent in **Dashboard** with a payout account you control in the Stellar CLI:
   `stellar keys generate demo-agent --secure-store && stellar keys fund demo-agent --network testnet`.
4. Start the agent: `AGENTFLOW_AGENT_KEY=afk_… AGENT_PAYOUT_SECRET_STELLAR_KEY=demo-agent pnpm --filter @agentflow/reference-agent start`. It applies within one poll.
5. As the client, **Assign** the agent. The agent executes, submits and records its submission on-chain; the task moves to *under review* with a verification report.
6. **Approve and release payment**. When confirmed, the task is *paid*; every transaction links to stellar.expert.

Alternative paths to try: reject (the reference agent disputes verified output), resolve as the arbiter (sign in with the arbiter key), refund an unassigned task, or wait out the review window and watch the agent claim.

## 5. Automated end-to-end run

```bash
pnpm --filter @agentflow/e2e testnet
```

Runs the happy path, unauthorized release attempts, reconciliation of a refund sent outside the API, and a dispute resolved by the arbiter, all with real testnet transactions, and writes every transaction hash to `deployments/e2e-testnet-*.json`.

## Recovering from failed or expired transactions

- Prepared transactions are valid for 5 minutes. If a wallet signature takes longer, the submit returns `TX_EXPIRED`; prepare again.
- If the network rejects a transaction (`failed`), nothing moved; any pending status (e.g. *approved*) reverts and the action can be retried.
- If submission is ambiguous, the operation stays `submitted`; the worker resends it while it is valid and marks it `expired` once the network has passed its time bounds. Expired means it can never be included.
- If the API was down while a signed transaction landed, the reconciler reads the contract and updates the task. `POST /tasks/:id/sync` forces this immediately.
- A prepared transaction can also be signed and sent with the Stellar CLI; reconciliation picks it up.

## Production notes

Not production-ready: no audit, single-key arbiter, testnet only. Before mainnet: an independent audit, a multisig arbiter, a secrets manager for the SEP-10 key, TLS termination and a reverse proxy (set `trustProxy` accordingly), monitoring of the worker and RPC, and backups.
