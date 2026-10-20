/**
 * Runs the reference agent against the real API over HTTP (Postgres-backed),
 * with the in-memory escrow stand-in in place of the network.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairSigner } from "@agentflow/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker } from "../../../apps/api/src/worker.ts";
import {
  call,
  chainOp,
  type Harness,
  setup,
  signIn,
  taskBody,
} from "../../../apps/api/test/helpers.ts";
import { ReferenceAgent } from "../src/agent.ts";

let h: Harness;
let url: string;
let stopWorker: () => void;
const logs: Record<string, unknown>[] = [];

beforeAll(async () => {
  h = await setup();
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const address = h.app.server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  stopWorker = startWorker(
    { db: h.db, chain: h.chain, log: { info() {}, warn() {}, error() {} } },
    150,
  );
});
afterAll(async () => {
  stopWorker?.();
  await h?.close();
});

async function newAgent(minReward = "1") {
  const operator = await signIn(h);
  const payout = Keypair.random();
  const reg = await call(h, "POST", "/agents", operator, {
    name: `ref-${crypto.randomUUID().slice(0, 6)}`,
    payoutAddress: payout.publicKey(),
    capabilities: [{ taskType: "csv-aggregate", maxRows: 1000 }],
  });
  const agent = new ReferenceAgent({
    apiUrl: url,
    apiKey: reg.body.apiKey,
    signer: keypairSigner(payout.secret()),
    minReward,
    stateDir: await mkdtemp(join(tmpdir(), "agentflow-agent-")),
    maxExecutionAttempts: 2,
    maxFeeStroops: 50_000_000n,
    log: (e) => logs.push(e),
  });
  await agent.init();
  return { agent, id: reg.body.agent.id as string };
}

async function openTask(overrides: Record<string, unknown> = {}) {
  const client = await signIn(h);
  const created = await call(h, "POST", "/tasks", client, taskBody(overrides));
  await chainOp(h, created.body.id, client, { action: "fund" });
  await waitFor(
    async () => (await call(h, "GET", `/tasks/${created.body.id}`)).body.status === "open",
  );
  return { client, id: created.body.id as string };
}

async function waitFor(check: () => Promise<boolean>, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting");
}

const status = async (id: string) => (await call(h, "GET", `/tasks/${id}`)).body.status;

describe("reference agent", () => {
  it("discovers, applies, executes, submits on-chain and gets paid", async () => {
    const { agent } = await newAgent();
    const { client, id } = await openTask();

    await agent.runOnce();
    const apps = await call(h, "GET", `/tasks/${id}/applications`, client);
    expect(apps.body).toHaveLength(1);

    await chainOp(h, id, client, { action: "accept_application", applicationId: apps.body[0].id });
    await waitFor(async () => (await status(id)) === "assigned");

    await agent.runOnce();
    expect(await status(id)).toBe("under_review");
    const history = await call(h, "GET", `/tasks/${id}/history`, client);
    expect(history.body.submissions).toHaveLength(1);
    expect(history.body.submissions[0].verification.matches).toBe(true);
    expect(history.body.agentRuns.map((r: { status: string }) => r.status)).toEqual(
      expect.arrayContaining(["evaluating", "accepted", "executing", "succeeded", "submitted"]),
    );

    // A second pass must not execute or submit again.
    await agent.runOnce();
    const again = await call(h, "GET", `/tasks/${id}/history`, client);
    expect(again.body.submissions).toHaveLength(1);
    expect(
      again.body.chainOps.filter((o: { action: string }) => o.action === "submit"),
    ).toHaveLength(1);

    await chainOp(h, id, client, { action: "approve" });
    await waitFor(async () => (await status(id)) === "paid");
  });

  it("declines tasks below its minimum reward and does not apply", async () => {
    const { agent } = await newAgent("1000");
    const { client, id } = await openTask();
    await agent.runOnce();
    expect((await call(h, "GET", `/tasks/${id}/applications`, client)).body).toHaveLength(0);
    expect(logs.some((l) => l.event === "declined" && l.taskId === id)).toBe(true);
  });

  it("disputes a rejection of output that matches recomputation", async () => {
    const { agent } = await newAgent();
    const { client, id } = await openTask();
    await agent.runOnce();
    const apps = await call(h, "GET", `/tasks/${id}/applications`, client);
    const mine = apps.body.at(-1);
    await chainOp(h, id, client, { action: "accept_application", applicationId: mine.id });
    await waitFor(async () => (await status(id)) === "assigned");
    await agent.runOnce();
    expect(await status(id)).toBe("under_review");

    await chainOp(h, id, client, { action: "reject", reason: "I don't like it" });
    await waitFor(async () => (await status(id)) === "rejected");
    await agent.runOnce();
    expect(await status(id)).toBe("disputed");
    const history = await call(h, "GET", `/tasks/${id}/history`, client);
    expect(history.body.disputes[0].reason).toMatch(
      /matches the platform's deterministic recomputation/,
    );
  });

  it("refuses to sign a transaction that is not the expected escrow call", async () => {
    const { agent } = await newAgent();
    const { client, id } = await openTask();
    await agent.runOnce();
    const apps = await call(h, "GET", `/tasks/${id}/applications`, client);
    await chainOp(h, id, client, {
      action: "accept_application",
      applicationId: apps.body.at(-1).id,
    });
    await waitFor(async () => (await status(id)) === "assigned");

    // Point the agent at the wrong escrow contract: it must refuse to sign.
    (agent as unknown as { escrowContract: string }).escrowContract = "C".padEnd(56, "A");
    await agent.runOnce();
    expect(logs.some((l) => l.taskId === id && String(l.error).includes("refusing to sign"))).toBe(
      true,
    );
    expect(await status(id)).toBe("in_progress");
  });
});
