/**
 * End-to-end workflow on Stellar TESTNET with real transactions.
 *
 * Starts the API and worker in-process against the local Postgres, creates
 * fresh in-memory keypairs (funded by Friendbot; never written to disk), runs
 * the real reference agent, and verifies every outcome against the contract.
 *
 *   A. task → fund → apply → assign → execute → submit → approve → paid
 *   B. unauthorized release attempts are refused (contract and API)
 *   C. a refund signed and sent straight to the network, bypassing the API
 *      (as if the API crashed), is reconciled from chain state
 *   D. reject → agent disputes → arbiter resolves 50/50
 *
 * Usage: node --env-file=.env tests/e2e/testnet-e2e.ts
 * Writes deployments/e2e-testnet-<timestamp>.json with every tx hash.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSV_AGGREGATE } from "@agentflow/shared";
import { cliSigner, EscrowClient, keypairSigner, type Signer } from "@agentflow/stellar";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  rpc,
  scValToNative,
  type Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { ReferenceAgent } from "../../agents/reference-agent/src/agent.ts";
import { buildApp } from "../../apps/api/src/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { migrate } from "../../apps/api/src/db/migrate.ts";
import { createPool } from "../../apps/api/src/db/pool.ts";
import { stellarGateway } from "../../apps/api/src/gateway.ts";
import { reconcileTasks, startWorker } from "../../apps/api/src/worker.ts";

const ROOT = new URL("../../", import.meta.url);
const deployment = JSON.parse(await readFile(new URL("deployments/testnet.json", ROOT), "utf8"));
const evidence: Record<string, unknown> = {
  network: "testnet",
  contractId: deployment.contractId,
  steps: [],
};
const steps = evidence.steps as { step: string; detail?: unknown }[];

function log(step: string, detail?: unknown) {
  steps.push({ step, detail });
  console.log(`✔ ${step}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

// ----- Setup -----------------------------------------------------------------

const config = loadConfig({
  ...process.env,
  ESCROW_CONTRACT_ID: deployment.contractId,
  ARBITER_ADDRESS: deployment.arbiter,
  ASSETS: JSON.stringify(deployment.assets),
  LOG_LEVEL: "warn",
});
const db = createPool(config.DATABASE_URL);
await migrate(db);
const chain = stellarGateway(config);
const app = buildApp({ config, db, chain });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const API = `http://127.0.0.1:${port}`;
const workerLog = {
  info() {},
  warn: (o: unknown) => console.warn("worker:", o),
  error: (o: unknown) => console.error("worker:", o),
};
const workerDeps = { db, chain, events: chain.client, log: workerLog };
let stopWorker = startWorker(workerDeps, 3000);
const escrow = new EscrowClient({
  rpcUrl: config.STELLAR_RPC_URL,
  networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
  contractId: deployment.contractId,
});
const xlm = deployment.assets[0].contractId as string;
const PASS = config.STELLAR_NETWORK_PASSPHRASE;

async function friendbot(kp: Keypair) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  assert(res.ok, `friendbot funding failed: ${res.status}`);
}

async function http(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // biome-ignore lint/suspicious/noExplicitAny: E2E assertions read response fields directly
  const json: any = await res.json();
  return { status: res.status, body: json };
}

async function signIn(signer: Signer) {
  const ch = await http("POST", "/auth/challenge", undefined, { address: signer.publicKey });
  const res = await http("POST", "/auth/token", undefined, {
    transaction: signer.sign(ch.body.transaction, PASS),
  });
  assert(res.status === 200, `sign-in failed ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 120_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** The same prepare → sign → submit → confirm path the web wallet uses. */
async function chainOp(taskId: string, token: string, signer: Signer, request: object) {
  const prep = await http("POST", `/tasks/${taskId}/chain-ops`, token, request);
  assert(
    prep.status === 201,
    `prepare ${JSON.stringify(request)} failed: ${JSON.stringify(prep.body)}`,
  );
  const sent = await http("POST", `/chain-ops/${prep.body.id}/signed`, token, {
    signedXdr: signer.sign(prep.body.xdr, PASS),
  });
  assert(sent.status === 200, `submit failed: ${JSON.stringify(sent.body)}`);
  const op = await waitFor<{
    status: string;
    txHash: string;
    ledger: number;
    error: string | null;
  }>("confirmation", async () => {
    const o = await http("GET", `/chain-ops/${prep.body.id}`, token);
    return o.body.status !== "submitted" ? o.body : null;
  });
  assert(op.status === "confirmed", `transaction ${op.txHash} ended ${op.status}: ${op.error}`);
  return op as { txHash: string; ledger: number };
}

async function tokenBalance(account: string): Promise<bigint> {
  const tx = new TransactionBuilder(
    new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    {
      fee: BASE_FEE,
      networkPassphrase: PASS,
    },
  )
    .addOperation(new Contract(xlm).call("balance", new Address(account).toScVal()))
    .setTimeout(60)
    .build();
  const sim = await escrow.server.simulateTransaction(tx);
  assert(rpc.Api.isSimulationSuccess(sim) && sim.result, "balance simulation failed");
  return BigInt(scValToNative(sim.result.retval) as bigint);
}

const status = async (id: string) => (await http("GET", `/tasks/${id}`)).body.status as string;
const task = (title: string, amount: string) => ({
  title,
  description: "Aggregate weekly sales per region.",
  acceptanceCriteria: "Output must match a deterministic recomputation of the specification.",
  spec: {
    type: CSV_AGGREGATE,
    version: 1,
    csv: "region,amount\neu,10.50\nus,3\neu,0.25\nus,4\nasia,7.10\n",
    groupBy: "region",
    metrics: [
      { column: "amount", op: "sum" },
      { column: "amount", op: "avg" },
      { column: "amount", op: "count" },
    ],
    decimals: 2,
  },
  reward: { asset: "XLM", amount },
  deadline: new Date(Date.now() + 86_400_000).toISOString(),
});

let exitCode = 0;
try {
  // ----- Actors --------------------------------------------------------------
  const client = Keypair.random();
  const operator = Keypair.random();
  const payout = Keypair.random();
  await Promise.all([friendbot(client), friendbot(operator), friendbot(payout)]);
  log("funded fresh testnet accounts with Friendbot", {
    client: client.publicKey(),
    operator: operator.publicKey(),
    agentPayout: payout.publicKey(),
  });

  const clientSigner = keypairSigner(client.secret());
  const clientToken = await signIn(clientSigner);
  const operatorToken = await signIn(keypairSigner(operator.secret()));
  log("client and operator signed in with SEP-10");

  const reg = await http("POST", "/agents", operatorToken, {
    name: `reference-${Date.now()}`,
    description: "AgentFlow reference agent (testnet E2E)",
    payoutAddress: payout.publicKey(),
    capabilities: [{ taskType: "csv-aggregate", maxRows: 5000 }],
  });
  assert(reg.status === 201, `agent registration failed ${JSON.stringify(reg.body)}`);
  const agent = new ReferenceAgent({
    apiUrl: API,
    apiKey: reg.body.apiKey,
    signer: keypairSigner(payout.secret()),
    minReward: "1",
    stateDir: await mkdtemp(join(tmpdir(), "agentflow-e2e-agent-")),
    maxExecutionAttempts: 2,
    maxFeeStroops: 50_000_000n,
    log: (e) => console.log("  agent:", JSON.stringify(e)),
  });
  await agent.init();
  log("registered the reference agent", { agentId: reg.body.agent.id });

  // ----- A. Happy path ---------------------------------------------------------
  const a = await http("POST", "/tasks", clientToken, task("E2E A: aggregate sales", "10"));
  assert(a.status === 201, "task creation failed");
  const aId = a.body.id as string;
  const contractBefore = await tokenBalance(deployment.contractId);
  const fundA = await chainOp(aId, clientToken, clientSigner, { action: "fund" });
  await waitFor("task A open", async () => (await status(aId)) === "open");
  const onFunded = await escrow.readTask(a.body.onchainId);
  assert(
    onFunded?.state === "Funded" && onFunded.amount === 100_000_000n,
    "escrow should hold exactly 10 XLM",
  );
  assert(
    (await tokenBalance(deployment.contractId)) - contractBefore === 100_000_000n,
    "contract balance +10 XLM",
  );
  log("A: client funded the escrow (real tx)", { tx: fundA.txHash, onchain: onFunded.state });

  await agent.runOnce();
  const apps = await http("GET", `/tasks/${aId}/applications`, clientToken);
  assert(apps.body.length === 1, "agent should have applied");
  log("A: agent discovered the task, evaluated it and applied");

  const assignA = await chainOp(aId, clientToken, clientSigner, {
    action: "accept_application",
    applicationId: apps.body[0].id,
  });
  await waitFor("task A assigned", async () => (await status(aId)) === "assigned");
  log("A: client assigned the agent on-chain", { tx: assignA.txHash });

  await agent.runOnce();
  await waitFor("task A under review", async () => (await status(aId)) === "under_review");
  const histA = await http("GET", `/tasks/${aId}/history`, clientToken);
  const sub = histA.body.submissions[0];
  assert(sub.verification.matches, "submission must match recomputation");
  const onSubmitted = await escrow.readTask(a.body.onchainId);
  assert(onSubmitted?.state === "Submitted", "escrow should be Submitted");
  log("A: agent executed in its sandbox and recorded the submission on-chain", {
    output: sub.output.rows,
    evidence: sub.digest,
    tx: histA.body.chainOps.find((o: { action: string }) => o.action === "submit").tx_hash,
  });

  const payoutBefore = await tokenBalance(payout.publicKey());
  const approveA = await chainOp(aId, clientToken, clientSigner, { action: "approve" });
  await waitFor("task A paid", async () => (await status(aId)) === "paid");
  const onReleased = await escrow.readTask(a.body.onchainId);
  assert(onReleased?.state === "Released", "escrow should be Released");
  const payoutDelta = (await tokenBalance(payout.publicKey())) - payoutBefore;
  assert(payoutDelta === 100_000_000n, `agent should receive exactly 10 XLM, got ${payoutDelta}`);
  assert(
    (await tokenBalance(deployment.contractId)) === contractBefore,
    "contract balance back to start",
  );
  log("A: client approved; contract released exactly 10 XLM to the agent", {
    tx: approveA.txHash,
    payoutDelta: payoutDelta.toString(),
  });

  // ----- B. Unauthorized release ------------------------------------------------
  const again = await http("POST", `/tasks/${aId}/chain-ops`, clientToken, { action: "approve" });
  assert(again.status === 409, "second approve must be refused");
  const b = await http("POST", "/tasks", clientToken, task("E2E B: unauthorized release", "2"));
  await chainOp(b.body.id, clientToken, clientSigner, { action: "fund" });
  await waitFor("task B open", async () => (await status(b.body.id)) === "open");
  const viaApi = await http("POST", `/tasks/${b.body.id}/chain-ops`, reg.body.apiKey, {
    action: "refund",
  });
  assert(viaApi.status === 403, "agent must not be able to refund through the API");
  // Simulation only records which authorizations are needed; enforcement
  // happens on submission. Sign the refund with the agent's key alone and
  // send it: the network must reject it and the escrow must be untouched.
  const forged = await escrow.prepare(payout.publicKey(), {
    fn: "refund",
    taskId: b.body.onchainId,
  });
  const forgedTx = TransactionBuilder.fromXDR(forged.xdr, PASS) as Transaction;
  forgedTx.sign(payout);
  const forgedSend = await escrow.send(forgedTx);
  let forgedResult = forgedSend.status as string;
  if (forgedSend.status === "PENDING") {
    forgedResult = (await escrow.server.pollTransaction(forged.hash, { attempts: 30 })).status;
  }
  assert(
    forgedResult === "ERROR" || forgedResult === "FAILED",
    `forged refund must fail, got ${forgedResult}`,
  );
  assert((await escrow.readTask(b.body.onchainId))?.state === "Funded", "task B escrow untouched");
  steps.push({
    step: "B: agent-signed refund rejected by the network",
    detail: { tx: forged.hash, result: forgedResult },
  });
  log("B: double approval and an agent-signed refund were refused by the API and the contract");

  // ----- C. Interrupted request reconciled from chain ------------------------------
  // Pause the background worker so this scenario exercises reconciliation
  // itself; otherwise its event indexer can record the refund first.
  await stopWorker();
  const prep = await http("POST", `/tasks/${b.body.id}/chain-ops`, clientToken, {
    action: "refund",
  });
  const tx = TransactionBuilder.fromXDR(prep.body.xdr, PASS) as Transaction;
  tx.sign(client);
  const sent = await escrow.send(tx); // straight to the network; the API never sees it
  const outcome = await escrow.server.pollTransaction(sent.hash, { attempts: 30 });
  assert(outcome.status === "SUCCESS", "direct refund should succeed");
  assert((await status(b.body.id)) === "open", "API does not know yet");
  await db.query("update tasks set last_synced_at = null where id = $1", [b.body.id]);
  await reconcileTasks({ db, chain, log: workerLog }, 0);
  assert((await status(b.body.id)) === "refunded", "reconciliation should mark task B refunded");
  log("C: refund sent outside the API was reconciled from chain state", { tx: sent.hash });
  stopWorker = startWorker(workerDeps, 3000);

  // ----- D. Rejection, dispute, arbiter ruling -----------------------------------------
  const d = await http("POST", "/tasks", clientToken, task("E2E D: disputed work", "4"));
  const dId = d.body.id as string;
  await chainOp(dId, clientToken, clientSigner, { action: "fund" });
  await waitFor("task D open", async () => (await status(dId)) === "open");
  await agent.runOnce();
  const dApps = await http("GET", `/tasks/${dId}/applications`, clientToken);
  await chainOp(dId, clientToken, clientSigner, {
    action: "accept_application",
    applicationId: dApps.body[0].id,
  });
  await waitFor("task D assigned", async () => (await status(dId)) === "assigned");
  await agent.runOnce();
  await waitFor("task D under review", async () => (await status(dId)) === "under_review");
  const rejectD = await chainOp(dId, clientToken, clientSigner, {
    action: "reject",
    reason: "Not what I wanted",
  });
  await waitFor("task D rejected", async () => (await status(dId)) === "rejected");
  await agent.runOnce();
  await waitFor("task D disputed", async () => (await status(dId)) === "disputed");
  log("D: client rejected verified work; the agent disputed on-chain", {
    rejectTx: rejectD.txHash,
  });

  // The arbiter key stays in the OS keyring; the Stellar CLI signs for it.
  const arbiter = cliSigner("agentflow-arbiter");
  assert(arbiter.publicKey === deployment.arbiter, "keyring arbiter does not match the deployment");
  const arbiterToken = await signIn(arbiter);
  const clientBeforeD = await tokenBalance(client.publicKey());
  const payoutBeforeD = await tokenBalance(payout.publicKey());
  const resolveD = await chainOp(dId, arbiterToken, arbiter, {
    action: "resolve",
    payeeBps: 5000,
    reason:
      "Output is correct per the stated criteria; the client's objection is outside them. Split 50/50 for the demo.",
  });
  await waitFor("task D resolved", async () => (await status(dId)) === "resolved");
  const toAgent = (await tokenBalance(payout.publicKey())) - payoutBeforeD;
  const toClient = (await tokenBalance(client.publicKey())) - clientBeforeD;
  assert(
    toAgent === 20_000_000n && toClient === 20_000_000n,
    `expected 2 XLM each, got ${toAgent}/${toClient}`,
  );
  log("D: arbiter resolved 50/50; each party received exactly 2 XLM", { tx: resolveD.txHash });
} catch (e) {
  exitCode = 1;
  console.error(e);
  evidence.error = String(e);
} finally {
  stopWorker();
  await app.close();
  await db.end();
  const file = new URL(
    `deployments/e2e-testnet-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    ROOT,
  );
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nevidence written to ${file.pathname}`);
  process.exit(exitCode);
}
