import { encodeArgs } from "@agentflow/stellar";
import { Account, BASE_FEE, Contract, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pollSubmittedOps, reconcileTasks } from "../src/worker.ts";
import {
  buildSubmission,
  call,
  chainOp,
  type Harness,
  PASS,
  SPEC,
  setup,
  sign,
  signIn,
  taskBody,
  type Who,
} from "./helpers.ts";

let h: Harness;
const log = { info() {}, warn() {}, error() {} };
const worker = () => pollSubmittedOps({ db: h.db, chain: h.chain, log });

beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});

interface Agent {
  id: string;
  key: string;
  payout: Keypair;
  operator: Who;
}

async function registerAgent(name = `agent-${crypto.randomUUID().slice(0, 8)}`): Promise<Agent> {
  const operator = await signIn(h);
  const payout = Keypair.random();
  const res = await call(h, "POST", "/agents", operator, {
    name,
    payoutAddress: payout.publicKey(),
    capabilities: [{ taskType: "csv-aggregate" }],
  });
  expect(res.status).toBe(201);
  return { id: res.body.agent.id, key: res.body.apiKey, payout, operator };
}

const agentWho = (a: Agent): Who => ({ token: a.key, kp: a.payout });

async function fundedTask(client?: Who) {
  const c = client ?? (await signIn(h));
  const created = await call(h, "POST", "/tasks", c, taskBody());
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  const funded = await chainOp(h, id, c, { action: "fund" });
  expect(funded.status).toBe(200);
  await worker();
  expect((await call(h, "GET", `/tasks/${id}`)).body.status).toBe("open");
  return { client: c, id };
}

async function assignedTask() {
  const { client, id } = await fundedTask();
  const agent = await registerAgent();
  const app = await call(h, "POST", `/tasks/${id}/applications`, agent.key, {
    message: "I can do this",
  });
  expect(app.status).toBe(201);
  const accepted = await chainOp(h, id, client, {
    action: "accept_application",
    applicationId: app.body.id,
  });
  expect(accepted.status).toBe(200);
  await worker();
  return { client, id, agent };
}

async function submittedTask() {
  const t = await assignedTask();
  const sub = await call(
    h,
    "POST",
    `/tasks/${t.id}/submissions`,
    t.agent.key,
    await buildSubmission(SPEC),
  );
  expect(sub.status).toBe(201);
  const op = await chainOp(h, t.id, agentWho(t.agent), {
    action: "submit",
    submissionId: sub.body.id,
  });
  expect(op.status).toBe(200);
  await worker();
  expect((await call(h, "GET", `/tasks/${t.id}`)).body.status).toBe("under_review");
  return { ...t, submissionId: sub.body.id as string };
}

describe("auth", () => {
  it("signs in with a SEP-10 challenge and rejects reuse", async () => {
    const kp = Keypair.random();
    const ch = await call(h, "POST", "/auth/challenge", null, { address: kp.publicKey() });
    const tx = TransactionBuilder.fromXDR(ch.body.transaction, PASS);
    tx.sign(kp);
    const first = await call(h, "POST", "/auth/token", null, { transaction: tx.toXdr() });
    expect(first.status).toBe(200);
    const me = await call(h, "GET", "/me", first.body.token);
    expect(me.body.user.address).toBe(kp.publicKey());
    const again = await call(h, "POST", "/auth/token", null, { transaction: tx.toXdr() });
    expect(again.status).toBe(401);
  });

  it("rejects a challenge signed by a different key", async () => {
    const kp = Keypair.random();
    const ch = await call(h, "POST", "/auth/challenge", null, { address: kp.publicKey() });
    const res = await call(h, "POST", "/auth/token", null, {
      transaction: sign(ch.body.transaction, Keypair.random()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects bad tokens and rotated agent keys", async () => {
    expect((await call(h, "GET", "/me", "afs_nope")).status).toBe(401);
    const agent = await registerAgent();
    expect((await call(h, "GET", "/me", agent.key)).body.kind).toBe("agent");
    const rotated = await call(h, "POST", `/agents/${agent.id}/keys/rotate`, agent.operator);
    expect((await call(h, "GET", "/me", agent.key)).status).toBe(401);
    expect((await call(h, "GET", "/me", rotated.body.apiKey)).status).toBe(200);
  });
});

describe("task creation", () => {
  it("validates input and keeps drafts private", async () => {
    const client = await signIn(h);
    const bad = await call(
      h,
      "POST",
      "/tasks",
      client,
      taskBody({ spec: { ...SPEC, groupBy: "country" } }),
    );
    expect(bad.status).toBe(400);
    expect(
      (await call(h, "POST", "/tasks", client, taskBody({ reward: { asset: "BTC", amount: "1" } })))
        .status,
    ).toBe(400);
    expect((await call(h, "POST", "/tasks", null, taskBody())).status).toBe(401);

    const draft = await call(h, "POST", "/tasks", client, taskBody());
    expect(draft.body.status).toBe("draft");
    expect(draft.body.reward.baseUnits).toBe("125000000");
    expect((await call(h, "GET", `/tasks/${draft.body.id}`)).status).toBe(404);
    expect((await call(h, "GET", `/tasks/${draft.body.id}`, client)).status).toBe(200);

    const cancelled = await call(h, "POST", `/tasks/${draft.body.id}/cancel`, client);
    expect(cancelled.body.status).toBe("cancelled");
  });
});

describe("full task-to-payment workflow", () => {
  it("funds, assigns, executes, submits, approves and pays", async () => {
    const t = await submittedTask();
    const history = await call(h, "GET", `/tasks/${t.id}/history`, t.client);
    const submission = history.body.submissions[0];
    expect(submission.verification.matches).toBe(true);
    expect(submission.status).toBe("submitted");

    const prep = await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.client, { action: "approve" });
    expect(prep.status).toBe(201);
    expect(prep.body.signer).toBe(t.client.kp.publicKey());
    h.chain.next = "drop"; // keep it in flight to observe the pending status
    const sent = await call(h, "POST", `/chain-ops/${prep.body.id}/signed`, t.client, {
      signedXdr: sign(prep.body.xdr, t.client.kp),
    });
    expect(sent.body.status).toBe("submitted");
    expect((await call(h, "GET", `/tasks/${t.id}`)).body.status).toBe("approved");

    h.chain.include(prep.body.txHash);
    await worker();
    const done = await call(h, "GET", `/tasks/${t.id}/history`, t.client);
    expect(done.body.task.status).toBe("paid");
    expect(done.body.reviews[0].decision).toBe("approved");
    expect(done.body.submissions[0].status).toBe("approved");
    expect(done.body.chainOps.every((o: { status: string }) => o.status === "confirmed")).toBe(
      true,
    );
    expect(done.body.chainOps.map((o: { action: string }) => o.action)).toEqual([
      "fund",
      "accept_application",
      "submit",
      "approve",
    ]);

    // No second payment.
    const again = await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.client, {
      action: "approve",
    });
    expect(again.status).toBe(409);
  });
});

describe("authorization", () => {
  it("only the client can approve, and only the assigned agent can submit", async () => {
    const t = await submittedTask();
    const stranger = await signIn(h);
    expect(
      (await call(h, "POST", `/tasks/${t.id}/chain-ops`, stranger, { action: "approve" })).status,
    ).toBe(403);
    expect(
      (await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.agent.key, { action: "approve" }))
        .status,
    ).toBe(403);

    const other = await registerAgent();
    const sub = await call(
      h,
      "POST",
      `/tasks/${t.id}/submissions`,
      other.key,
      await buildSubmission(SPEC),
    );
    expect(sub.status).toBe(403);
  });

  it("an agent cannot apply to its operator's own task", async () => {
    const agent = await registerAgent();
    const { id } = await fundedTask(agent.operator);
    expect((await call(h, "POST", `/tasks/${id}/applications`, agent.key, {})).status).toBe(403);
  });

  it("rejects a tampered or wrongly signed transaction", async () => {
    const t = await submittedTask();
    const prep = await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.client, { action: "approve" });
    const wrongSigner = await call(h, "POST", `/chain-ops/${prep.body.id}/signed`, t.client, {
      signedXdr: sign(prep.body.xdr, Keypair.random()),
    });
    expect(wrongSigner.status).toBe(400);

    // A different, validly signed transaction (refund instead of approve).
    const task = await call(h, "GET", `/tasks/${t.id}`);
    const other = new TransactionBuilder(new Account(t.client.kp.publicKey(), "7"), {
      fee: BASE_FEE,
      networkPassphrase: PASS,
    })
      .addOperation(
        new Contract(h.chain.contractId).call(
          "refund",
          ...encodeArgs({ fn: "refund", taskId: task.body.onchainId }),
        ),
      )
      .setTimeout(300)
      .build();
    other.sign(t.client.kp);
    const swapped = await call(h, "POST", `/chain-ops/${prep.body.id}/signed`, t.client, {
      signedXdr: other.toXdr(),
    });
    expect(swapped.status).toBe(400);
    expect((await call(h, "GET", `/tasks/${t.id}`)).body.status).toBe("under_review");
  });

  it("only the arbiter resolves disputes", async () => {
    const t = await submittedTask();
    expect(
      (await chainOp(h, t.id, agentWho(t.agent), { action: "dispute", reason: "fair work" }))
        .status,
    ).toBe(200);
    await worker();
    expect((await call(h, "GET", `/tasks/${t.id}`)).body.status).toBe("disputed");

    const resolve = { action: "resolve", payeeBps: 6000, reason: "partially meets criteria" };
    expect((await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.client, resolve)).status).toBe(403);
    const arbiter = await signIn(h, h.arbiter);
    const disputes = await call(h, "GET", "/arbiter/disputes", arbiter);
    expect(disputes.body.some((d: { task_id: string }) => d.task_id === t.id)).toBe(true);
    expect((await chainOp(h, t.id, arbiter, resolve)).status).toBe(200);
    await worker();
    const history = await call(h, "GET", `/tasks/${t.id}/history`, arbiter);
    expect(history.body.task.status).toBe("resolved");
    expect(history.body.disputes[0]).toMatchObject({ status: "resolved", payee_bps: 6000 });
  });
});

describe("transaction failures never become payments", () => {
  it("reverts a failed release to under_review", async () => {
    const t = await submittedTask();
    h.chain.next = "fail";
    const sent = await chainOp(h, t.id, t.client, { action: "approve" });
    expect(sent.status).toBe(200);
    await worker();
    const after = await call(h, "GET", `/tasks/${t.id}/history`, t.client);
    expect(after.body.task.status).toBe("under_review");
    expect(after.body.chainOps.at(-1).status).toBe("failed");
    expect(after.body.reviews).toHaveLength(0);
  });

  it("expires a transaction never included before its time bounds", async () => {
    const t = await submittedTask();
    h.chain.next = "drop";
    const sent = await chainOp(h, t.id, t.client, { action: "approve" });
    expect(sent.body.status).toBe("submitted");
    await worker();
    expect((await call(h, "GET", `/tasks/${t.id}`)).body.status).toBe("approved"); // still unknown

    h.chain.closeTime = Math.floor(Date.now() / 1000) + 400; // network moved past max time
    try {
      await worker();
    } finally {
      h.chain.closeTime = Math.floor(Date.now() / 1000);
    }
    const after = await call(h, "GET", `/tasks/${t.id}/history`, t.client);
    expect(after.body.task.status).toBe("under_review");
    expect(after.body.chainOps.at(-1).status).toBe("expired");
  });

  it("treats an ambiguous send as pending until the network answers", async () => {
    const t = await submittedTask();
    h.chain.next = "try_later";
    const sent = await chainOp(h, t.id, t.client, { action: "approve" });
    expect(sent.body.status).toBe("submitted");
    await worker(); // resends; the fake includes it this time
    await worker();
    expect((await call(h, "GET", `/tasks/${t.id}`)).body.status).toBe("paid");
  });

  it("marks a send rejected by the network as failed immediately", async () => {
    const t = await submittedTask();
    h.chain.next = "send_error";
    const sent = await chainOp(h, t.id, t.client, { action: "approve" });
    expect(sent.body.status).toBe("failed");
    expect((await call(h, "GET", `/tasks/${t.id}`)).body.status).toBe("under_review");
  });

  it("surfaces contract errors at preparation time", async () => {
    const t = await assignedTask();
    const res = await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.client, { action: "refund" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ESCROW_DEADLINENOTPASSED");
  });
});

describe("idempotency and races", () => {
  it("returns the same prepared transaction for a repeated request", async () => {
    const t = await submittedTask();
    const a = await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.client, { action: "approve" });
    const b = await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.client, { action: "approve" });
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.txHash).toBe(a.body.txHash);
  });

  it("deduplicates applications and submissions", async () => {
    const t = await assignedTask();
    const again = await call(h, "POST", `/tasks/${t.id}/applications`, t.agent.key, {});
    expect(again.body.status).toBe("accepted");
    const body = await buildSubmission(SPEC, "same-key-123");
    const one = await call(h, "POST", `/tasks/${t.id}/submissions`, t.agent.key, body);
    const two = await call(h, "POST", `/tasks/${t.id}/submissions`, t.agent.key, body);
    expect(two.body.id).toBe(one.body.id);
    expect(two.body.attempt).toBe(1);
  });

  it("a superseded transaction cannot be submitted", async () => {
    const t = await submittedTask();
    const approve = await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.client, {
      action: "approve",
    });
    const dispute = await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.agent.key, {
      action: "dispute",
      reason: "racing",
    });
    expect(dispute.status).toBe(201);
    const late = await call(h, "POST", `/chain-ops/${approve.body.id}/signed`, t.client, {
      signedXdr: sign(approve.body.xdr, t.client.kp),
    });
    expect(late.status).toBe(409);
  });

  it("only one transaction per task can be in flight", async () => {
    const t = await submittedTask();
    h.chain.next = "drop";
    const sent = await chainOp(h, t.id, t.client, { action: "approve" });
    expect(sent.body.status).toBe("submitted");
    const second = await call(h, "POST", `/tasks/${t.id}/chain-ops`, t.agent.key, {
      action: "dispute",
      reason: "x",
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("TX_IN_FLIGHT");
    h.chain.include(sent.body.txHash);
    await worker();
  });

  it("concurrent accepts assign exactly one agent", async () => {
    const { client, id } = await fundedTask();
    const [a1, a2] = [await registerAgent(), await registerAgent()];
    const ap1 = await call(h, "POST", `/tasks/${id}/applications`, a1.key, {});
    const ap2 = await call(h, "POST", `/tasks/${id}/applications`, a2.key, {});
    const [p1, p2] = await Promise.all([
      call(h, "POST", `/tasks/${id}/chain-ops`, client, {
        action: "accept_application",
        applicationId: ap1.body.id,
      }),
      call(h, "POST", `/tasks/${id}/chain-ops`, client, {
        action: "accept_application",
        applicationId: ap2.body.id,
      }),
    ]);
    const results = await Promise.all(
      [p1, p2].map((p) =>
        call(h, "POST", `/chain-ops/${p.body.id}/signed`, client, {
          signedXdr: sign(p.body.xdr, client.kp),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    await worker();
    const apps = await call(h, "GET", `/tasks/${id}/applications`, client);
    expect(apps.body.filter((a: { status: string }) => a.status === "accepted")).toHaveLength(1);
  });
});

describe("rejection, refunds and reconciliation", () => {
  it("rejects, resubmits a second attempt and pays", async () => {
    const t = await submittedTask();
    expect(
      (await chainOp(h, t.id, t.client, { action: "reject", reason: "please recheck" })).status,
    ).toBe(200);
    await worker();
    expect((await call(h, "GET", `/tasks/${t.id}`)).body.status).toBe("rejected");

    const sub = await call(
      h,
      "POST",
      `/tasks/${t.id}/submissions`,
      t.agent.key,
      await buildSubmission(SPEC),
    );
    expect(sub.body.attempt).toBe(2);
    await chainOp(h, t.id, agentWho(t.agent), { action: "submit", submissionId: sub.body.id });
    await worker();
    await chainOp(h, t.id, t.client, { action: "approve" });
    await worker();
    const done = await call(h, "GET", `/tasks/${t.id}/history`, t.client);
    expect(done.body.task.status).toBe("paid");
    expect(done.body.reviews.map((r: { decision: string }) => r.decision)).toEqual([
      "rejected",
      "approved",
    ]);
  });

  it("refunds an unassigned task", async () => {
    const { client, id } = await fundedTask();
    expect((await chainOp(h, id, client, { action: "refund" })).status).toBe(200);
    await worker();
    expect((await call(h, "GET", `/tasks/${id}`)).body.status).toBe("refunded");
  });

  it("agent abandon reopens the task", async () => {
    const t = await assignedTask();
    expect((await chainOp(h, t.id, agentWho(t.agent), { action: "abandon" })).status).toBe(200);
    await worker();
    const task = await call(h, "GET", `/tasks/${t.id}`);
    expect(task.body.status).toBe("open");
    expect(task.body.assignedAgent).toBeNull();
  });

  it("reconciles a contract call made outside the API", async () => {
    const { client, id } = await fundedTask();
    const task = await call(h, "GET", `/tasks/${id}`);
    h.chain.direct(client.kp.publicKey(), { fn: "refund", taskId: task.body.onchainId });
    await h.db.query("update tasks set last_synced_at = null where id = $1", [id]);
    await reconcileTasks({ db: h.db, chain: h.chain, log }, 0);
    expect((await call(h, "GET", `/tasks/${id}`)).body.status).toBe("refunded");
  });

  it("flags a submission whose output does not match recomputation", async () => {
    const t = await assignedTask();
    const body = await buildSubmission(SPEC);
    body.output.rows[0] = ["eu", "999.00", "2"];
    const { hashJson } = await import("@agentflow/shared");
    body.evidence.outputSha256 = await hashJson(body.output);
    const sub = await call(h, "POST", `/tasks/${t.id}/submissions`, t.agent.key, body);
    expect(sub.status).toBe(201);
    expect(sub.body.verification.matches).toBe(false);

    // Evidence that does not match the output is refused outright.
    const lying = await buildSubmission(SPEC);
    lying.evidence.outputSha256 = "0".repeat(64);
    expect((await call(h, "POST", `/tasks/${t.id}/submissions`, t.agent.key, lying)).status).toBe(
      400,
    );
  });
});
