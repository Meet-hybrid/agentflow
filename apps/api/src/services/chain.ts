/**
 * Chain operations: every money-moving action goes through here.
 *
 *   prepare  → the API builds and simulates the contract call and records a
 *              `chain_ops` row (status "prepared") holding the exact tx hash.
 *   signed   → the responsible party returns the signed XDR; it must hash to
 *              the prepared tx and carry the expected signature. The op becomes
 *              "submitted" (at most one per task) and is sent to the network.
 *   outcome  → the worker polls the network. SUCCESS confirms the op and
 *              applies its effects; FAILED, or NOT_FOUND after the tx's time
 *              bounds have passed, marks it failed/expired and reverts any
 *              pending status. Nothing is marked paid without a confirmed tx.
 *   sync     → task status is re-derived from the contract's own state, so
 *              direct contract calls and missed updates are reconciled.
 */
import {
  type Action,
  type ChainFn,
  checkAction,
  type OnchainTask,
  type PrepareChainOpRequest,
  type Role,
  statusFromChain,
  type TaskStatus,
} from "@agentflow/shared";
import {
  type EscrowCall,
  EscrowError,
  type PreparedTx,
  type TxOutcome,
  verifySigned,
} from "@agentflow/stellar";
import type { Principal } from "../auth.ts";
import type { Config } from "../config.ts";
import { type Db, isUniqueViolation, type Tx, withTx } from "../db/pool.ts";
import { ApiError, badRequest, conflict, forbidden, notFound, unavailable } from "../errors.ts";
import { getTask, lockTask, recordEvent, roleOn, type TaskRow } from "./tasks.ts";

/** What the API needs from the network; implemented by EscrowClient. */
export interface ChainGateway {
  prepare(source: string, call: EscrowCall): Promise<PreparedTx>;
  readTask(onchainId: string): Promise<OnchainTask | null>;
  send(signedXdr: string): Promise<{ status: string; error?: string }>;
  outcome(hash: string): Promise<TxOutcome>;
}

export interface ChainOpRow {
  id: string;
  task_id: string;
  action: Action;
  contract_fn: ChainFn;
  params: Record<string, unknown>;
  signer: string;
  requested_by_type: "user" | "agent";
  requested_by_id: string;
  status: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "superseded";
  tx_hash: string;
  unsigned_xdr: string;
  signed_xdr: string | null;
  max_time: Date;
  from_status: TaskStatus;
  pending_status: TaskStatus | null;
  error: string | null;
  ledger: number | null;
}

export function opView(op: ChainOpRow) {
  return {
    id: op.id,
    taskId: op.task_id,
    action: op.action,
    contractFn: op.contract_fn,
    signer: op.signer,
    status: op.status,
    txHash: op.tx_hash,
    xdr: op.status === "prepared" ? op.unsigned_xdr : undefined,
    expiresAt: op.max_time.toISOString(),
    error: op.error,
    ledger: op.ledger,
  };
}

interface Plan {
  action: Action;
  role: Role;
  signer: string;
  call: EscrowCall;
  params: Record<string, unknown>;
}

/** Decides who signs what for an action, after checking permissions and state. */
async function plan(
  tx: Tx,
  config: Config,
  task: TaskRow,
  who: Principal,
  req: PrepareChainOpRequest,
): Promise<Plan> {
  const role = roleOn(config, task, who);
  const action: Action = req.action;
  if (!role) throw forbidden("you have no role on this task");
  const err = checkAction(action, task.status, role);
  if (err)
    throw err.code === "FORBIDDEN"
      ? forbidden(err.message)
      : conflict("INVALID_STATE", err.message);

  const taskId = task.onchain_id;
  const clientAddress = task.client_address;
  const payee = task.payee_address;
  switch (req.action) {
    case "fund": {
      if (task.deadline.getTime() < Date.now() + 5 * 60_000) {
        throw conflict(
          "DEADLINE_TOO_CLOSE",
          "deadline is too close to fund this task; create a new one",
        );
      }
      return {
        action,
        role,
        signer: clientAddress,
        params: {},
        call: {
          fn: "fund",
          taskId,
          client: clientAddress,
          token: task.asset_contract,
          amount: BigInt(task.amount),
          deadline: Math.floor(task.deadline.getTime() / 1000),
        },
      };
    }
    case "accept_application": {
      const { rows } = await tx.query<{
        id: string;
        status: string;
        payout_address: string;
        agent_id: string;
      }>(
        `select ap.id, ap.status, ag.payout_address, ag.id as agent_id
         from applications ap join agents ag on ag.id = ap.agent_id
         where ap.id = $1 and ap.task_id = $2 and ag.status = 'active'`,
        [req.applicationId, task.id],
      );
      const app = rows[0];
      if (!app) throw notFound("application");
      if (app.status !== "pending") throw conflict("INVALID_STATE", `application is ${app.status}`);
      if (app.payout_address === clientAddress)
        throw badRequest("the agent's payout address is the client's own");
      return {
        action,
        role,
        signer: clientAddress,
        params: { applicationId: app.id, agentId: app.agent_id, payee: app.payout_address },
        call: { fn: "assign", taskId, payee: app.payout_address },
      };
    }
    case "submit": {
      const { rows } = await tx.query<{ id: string; digest: string; status: string }>(
        "select id, digest, status from submissions where id = $1 and task_id = $2 and agent_id = $3",
        [req.submissionId, task.id, task.assigned_agent_id],
      );
      const sub = rows[0];
      if (!sub) throw notFound("submission");
      if (sub.status !== "pending_chain")
        throw conflict("INVALID_STATE", `submission is ${sub.status}`);
      return requirePayee(payee, {
        action,
        role,
        params: { submissionId: sub.id },
        call: { fn: "submit", taskId, evidence: sub.digest },
      });
    }
    case "approve":
    case "reject":
    case "refund":
      return {
        action,
        role,
        signer: clientAddress,
        params: "reason" in req ? { reason: req.reason } : {},
        call: { fn: req.action, taskId },
      };
    case "claim":
    case "abandon":
      return requirePayee(payee, { action, role, params: {}, call: { fn: req.action, taskId } });
    case "dispute": {
      const by = role === "client" ? clientAddress : payee;
      if (!by) throw conflict("INVALID_STATE", "task has no payee");
      return {
        action,
        role,
        signer: by,
        params: { reason: req.reason },
        call: { fn: "dispute", taskId, by },
      };
    }
    case "resolve":
      return {
        action,
        role,
        signer: config.ARBITER_ADDRESS,
        params: { payeeBps: req.payeeBps, reason: req.reason },
        call: { fn: "resolve", taskId, payeeBps: req.payeeBps },
      };
  }
}

function requirePayee(payee: string | null, p: Omit<Plan, "signer">): Plan {
  if (!payee) throw conflict("INVALID_STATE", "task has no payee");
  return { ...p, signer: payee };
}

const ACTION_FOR_ROLE_PENDING: Partial<Record<Action, TaskStatus>> = { approve: "approved" };

export async function prepareOp(
  db: Db,
  config: Config,
  chain: ChainGateway,
  who: Principal,
  taskId: string,
  req: PrepareChainOpRequest,
) {
  return withTx(db, async (tx) => {
    const task = await lockTask(tx, taskId);
    const inflight = await tx.query(
      "select id from chain_ops where task_id = $1 and status = 'submitted'",
      [task.id],
    );
    if (inflight.rowCount) {
      throw conflict(
        "TX_IN_FLIGHT",
        "another transaction for this task is being confirmed; retry shortly",
      );
    }
    const p = await plan(tx, config, task, who, req);

    // Idempotent: the same caller asking again gets the same unexpired tx.
    const { rows: reusable } = await tx.query<ChainOpRow>(
      `select * from chain_ops where task_id = $1 and status = 'prepared' and action = $2
         and requested_by_id = $3 and params = $4 and max_time > now() + interval '60 seconds'
       order by created_at desc limit 1`,
      [task.id, p.action, who.id, p.params],
    );
    if (reusable[0]) return opView(reusable[0]);

    let prepared: PreparedTx;
    try {
      prepared = await chain.prepare(p.signer, p.call);
    } catch (e) {
      if (e instanceof EscrowError && e.contractError) {
        throw conflict(`ESCROW_${e.contractError.toUpperCase()}`, e.message);
      }
      throw unavailable(`could not prepare the transaction: ${(e as Error).message}`);
    }

    // Unsigned transactions for this task are superseded; if one is signed and
    // sent to the network anyway, reconciliation picks up its effect.
    await tx.query(
      "update chain_ops set status = 'superseded', updated_at = now() where task_id = $1 and status = 'prepared'",
      [task.id],
    );
    const { rows } = await tx.query<ChainOpRow>(
      `insert into chain_ops (task_id, action, contract_fn, params, signer, requested_by_type, requested_by_id,
         tx_hash, unsigned_xdr, max_time, from_status, pending_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),$11,$12) returning *`,
      [
        task.id,
        p.action,
        p.call.fn,
        p.params,
        p.signer,
        who.kind,
        who.id,
        prepared.hash,
        prepared.xdr,
        prepared.maxTime,
        task.status,
        ACTION_FOR_ROLE_PENDING[p.action] ?? null,
      ],
    );
    const op = rows[0] as ChainOpRow;
    await recordEvent(tx, {
      taskId: task.id,
      actor: { type: who.kind, id: who.id },
      action: `prepare_${p.action}`,
      detail: { opId: op.id, txHash: op.tx_hash, signer: p.signer },
    });
    return opView(op);
  });
}

export async function getOp(db: Db, who: Principal, opId: string) {
  const { rows } = await db.query<ChainOpRow>("select * from chain_ops where id = $1", [opId]);
  const op = rows[0];
  if (!op || op.requested_by_id !== who.id) throw notFound("chain operation");
  return op;
}

/** Accepts the signed transaction for a prepared op and sends it. */
export async function submitSigned(
  db: Db,
  config: Config,
  chain: ChainGateway,
  who: Principal,
  opId: string,
  signedXdr: string,
) {
  const op = await withTx(db, async (tx) => {
    const { rows } = await tx.query<ChainOpRow>(
      "select * from chain_ops where id = $1 for update",
      [opId],
    );
    const op = rows[0];
    if (!op || op.requested_by_id !== who.id) throw notFound("chain operation");
    if (op.status !== "prepared") {
      // Re-sending the same signed tx is harmless; report current state.
      if (op.signed_xdr === signedXdr) return op;
      throw conflict("INVALID_STATE", `operation is already ${op.status}`);
    }
    if (op.max_time.getTime() <= Date.now()) {
      await tx.query(
        "update chain_ops set status = 'expired', finished_at = now(), updated_at = now() where id = $1",
        [op.id],
      );
      throw conflict("TX_EXPIRED", "the prepared transaction expired; prepare it again");
    }
    try {
      verifySigned(
        signedXdr,
        { hash: op.tx_hash, signer: op.signer },
        config.STELLAR_NETWORK_PASSPHRASE,
      );
    } catch (e) {
      throw badRequest((e as Error).message);
    }

    const task = await lockTask(tx, op.task_id);
    if (task.status !== op.from_status) {
      throw conflict(
        "STALE_OPERATION",
        `task changed from ${op.from_status} to ${task.status}; prepare again`,
      );
    }
    try {
      const { rows: updated } = await tx.query<ChainOpRow>(
        `update chain_ops set status = 'submitted', signed_xdr = $2, submitted_at = now(), updated_at = now()
         where id = $1 returning *`,
        [op.id, signedXdr],
      );
      if (op.pending_status) {
        await tx.query("update tasks set status = $2, updated_at = now() where id = $1", [
          task.id,
          op.pending_status,
        ]);
      }
      await recordEvent(tx, {
        taskId: task.id,
        actor: { type: who.kind, id: who.id },
        action: `submit_${op.action}`,
        from: task.status,
        to: op.pending_status ?? task.status,
        detail: { opId: op.id, txHash: op.tx_hash },
      });
      return updated[0] as ChainOpRow;
    } catch (e) {
      if (isUniqueViolation(e, "chain_ops_one_inflight")) {
        throw conflict("TX_IN_FLIGHT", "another transaction for this task is being confirmed");
      }
      throw e;
    }
  });

  if (op.status === "submitted") {
    const sent = await chain
      .send(signedXdr)
      .catch((e: unknown) => ({ status: "UNKNOWN", error: String(e) }));
    if (sent.status === "ERROR") {
      // Rejected before inclusion: it can never succeed.
      await finishOp(db, chain, op.id, {
        status: "failed",
        error: sent.error ?? "rejected by the network",
      });
    } else if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
      // TRY_AGAIN_LATER or a transport error: ambiguous. The worker resends
      // until the time bounds pass, then checks the outcome.
      await db.query("update chain_ops set error = $2, updated_at = now() where id = $1", [
        op.id,
        `send: ${sent.status} ${sent.error ?? ""}`.trim(),
      ]);
    }
  }
  const { rows } = await db.query<ChainOpRow>("select * from chain_ops where id = $1", [opId]);
  return opView(rows[0] as ChainOpRow);
}

/**
 * Checks a submitted op against the network. Returns true when the op reached
 * a final state.
 */
export async function pollOp(db: Db, chain: ChainGateway, op: ChainOpRow): Promise<boolean> {
  let outcome: TxOutcome;
  try {
    outcome = await chain.outcome(op.tx_hash);
  } catch {
    return false; // Network trouble: try again later; never guess.
  }
  if (outcome.status === "success") {
    await finishOp(db, chain, op.id, { status: "confirmed", ledger: outcome.ledger });
    return true;
  }
  if (outcome.status === "failed") {
    await finishOp(db, chain, op.id, {
      status: "failed",
      ledger: outcome.ledger,
      error: outcome.detail,
    });
    return true;
  }
  // NOT_FOUND: once the network has closed a ledger past the tx's max time,
  // the tx can never be included.
  if (outcome.latestLedgerCloseTime > Math.floor(op.max_time.getTime() / 1000)) {
    await finishOp(db, chain, op.id, {
      status: "expired",
      error: "not included before its time bounds",
    });
    return true;
  }
  if (op.signed_xdr) await chain.send(op.signed_xdr).catch(() => {});
  return false;
}

async function finishOp(
  db: Db,
  chain: ChainGateway,
  opId: string,
  result: { status: "confirmed" | "failed" | "expired"; ledger?: number; error?: string },
) {
  const taskId = await withTx(db, async (tx) => {
    const { rows } = await tx.query<ChainOpRow>(
      "select * from chain_ops where id = $1 for update",
      [opId],
    );
    const op = rows[0];
    if (op?.status !== "submitted") return null; // already handled
    await tx.query(
      `update chain_ops set status = $2, ledger = $3, error = $4, finished_at = now(), updated_at = now()
       where id = $1`,
      [op.id, result.status, result.ledger ?? null, result.error ?? null],
    );
    const task = await lockTask(tx, op.task_id);
    if (result.status === "confirmed") {
      await applyEffects(tx, op, task);
    } else if (op.pending_status && task.status === op.pending_status) {
      await tx.query("update tasks set status = $2, updated_at = now() where id = $1", [
        task.id,
        op.from_status,
      ]);
    }
    await recordEvent(tx, {
      taskId: task.id,
      actor: { type: "chain" },
      action: `${op.action}_${result.status}`,
      from: task.status,
      detail: { opId: op.id, txHash: op.tx_hash, ledger: result.ledger, error: result.error },
    });
    return task.id;
  });
  if (taskId) await syncTask(db, chain, taskId);
}

/** Off-chain records that accompany a confirmed contract call. */
async function applyEffects(tx: Tx, op: ChainOpRow, task: TaskRow) {
  const p = op.params as Record<string, string | number>;
  switch (op.action) {
    case "accept_application":
      await tx.query("update applications set status = 'accepted' where id = $1", [
        p.applicationId,
      ]);
      await tx.query(
        "update applications set status = 'declined' where task_id = $1 and id <> $2 and status = 'pending'",
        [task.id, p.applicationId],
      );
      await tx.query(
        "update tasks set assigned_agent_id = $2, payee_address = $3, updated_at = now() where id = $1",
        [task.id, p.agentId, p.payee],
      );
      break;
    case "submit":
      await tx.query("update submissions set status = 'submitted' where id = $1", [p.submissionId]);
      await tx.query("update tasks set submitted_at = now(), updated_at = now() where id = $1", [
        task.id,
      ]);
      break;
    case "approve":
    case "reject": {
      const { rows } = await tx.query<{ id: string }>(
        "select id from submissions where task_id = $1 and status = 'submitted' order by attempt desc limit 1",
        [task.id],
      );
      const decision = op.action === "approve" ? "approved" : "rejected";
      if (rows[0])
        await tx.query("update submissions set status = $2 where id = $1", [rows[0].id, decision]);
      await tx.query(
        `insert into reviews (task_id, submission_id, decision, reason, reviewer_id, chain_op_id)
         values ($1, $2, $3, $4, $5, $6) on conflict (chain_op_id) do nothing`,
        [task.id, rows[0]?.id ?? null, decision, p.reason ?? "", op.requested_by_id, op.id],
      );
      break;
    }
    case "abandon":
      await tx.query(
        "update tasks set assigned_agent_id = null, payee_address = null where id = $1",
        [task.id],
      );
      await tx.query(
        "update applications set status = 'withdrawn' where task_id = $1 and status = 'accepted'",
        [task.id],
      );
      break;
    case "dispute":
      await tx.query(
        `insert into disputes (task_id, opened_by_type, opened_by_id, reason, open_op_id)
         values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [task.id, op.requested_by_type, op.requested_by_id, p.reason ?? "", op.id],
      );
      break;
    case "resolve":
      await tx.query(
        `update disputes set status = 'resolved', payee_bps = $2, resolution_reason = $3, resolved_by = $4,
           resolve_op_id = $5, resolved_at = now()
         where task_id = $1 and status = 'open'`,
        [task.id, p.payeeBps, p.reason ?? "", op.requested_by_id, op.id],
      );
      break;
    default:
      break;
  }
}

/**
 * Re-derives the task's status from the escrow contract. Safe to call at any
 * time; it only ever moves the database toward the chain's state.
 */
export async function syncTask(db: Db, chain: ChainGateway, taskId: string) {
  const before = await getTask(db, taskId);
  let onchain: OnchainTask | null;
  try {
    onchain = await chain.readTask(before.onchain_id);
  } catch (e) {
    throw unavailable(`could not read escrow state: ${(e as Error).message}`);
  }
  return withTx(db, async (tx) => {
    const task = await lockTask(tx, taskId);
    const approving = await tx.query(
      "select 1 from chain_ops where task_id = $1 and action = 'approve' and status = 'submitted'",
      [taskId],
    );
    let next = statusFromChain(
      task.status,
      onchain,
      task.rejections,
      (approving.rowCount ?? 0) > 0,
    );

    // A confirmed submission is verified at submission time, so it goes
    // straight to review.
    if ((next ?? task.status) === "submitted") next = "under_review";

    const updates: string[] = ["last_synced_at = now()"];
    const args: unknown[] = [taskId];
    const set = (col: string, v: unknown) => {
      args.push(v);
      updates.push(`${col} = $${args.length}`);
    };
    if (next && next !== task.status) set("status", next);
    if (onchain) {
      if (onchain.rejections !== task.rejections) set("rejections", onchain.rejections);
      if (task.review_window_seconds !== onchain.reviewWindow)
        set("review_window_seconds", onchain.reviewWindow);
      if (onchain.payee && onchain.payee !== task.payee_address) {
        // Assigned outside the API: attach the agent with that payout address if unique.
        set("payee_address", onchain.payee);
        const { rows } = await tx.query<{ id: string }>(
          "select id from agents where payout_address = $1 and status = 'active'",
          [onchain.payee],
        );
        set("assigned_agent_id", rows.length === 1 ? rows[0]?.id : null);
      }
      if (
        !onchain.payee &&
        task.payee_address &&
        (onchain.state === "Funded" || onchain.state === "Refunded")
      ) {
        set("payee_address", null);
        set("assigned_agent_id", null);
      }
    }
    if (updates.length > 1 && next !== null) updates.push("updated_at = now()");
    await tx.query(`update tasks set ${updates.join(", ")} where id = $1`, args);
    if (next && next !== task.status) {
      await recordEvent(tx, {
        taskId,
        actor: { type: "chain" },
        action: "sync",
        from: task.status,
        to: next,
        detail: { onchainState: onchain?.state ?? null },
      });
    }
    return getTask(tx, taskId);
  });
}

export { ApiError };
