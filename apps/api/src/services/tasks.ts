import { randomBytes } from "node:crypto";
import {
  applyOffchain,
  type CreateTaskRequest,
  checkAction,
  csvAggregateOutputSchema,
  hashJson,
  type Role,
  runCsvAggregate,
  submissionDigest,
  type submissionRequest,
  type TaskStatus,
  type taskListQuery,
} from "@agentflow/shared";
import { fromBaseUnits, toBaseUnits } from "@agentflow/stellar";
import type { z } from "zod";
import type { AgentPrincipal, Principal, UserPrincipal } from "../auth.ts";
import type { Config } from "../config.ts";
import { type Db, isUniqueViolation, type Tx, withTx } from "../db/pool.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";

export interface TaskRow {
  id: string;
  onchain_id: string;
  client_id: string;
  client_address: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  task_type: string;
  spec: unknown;
  spec_sha256: string;
  asset_code: string;
  asset_contract: string;
  amount: string;
  deadline: Date;
  max_duration_seconds: number;
  status: TaskStatus;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  payee_address: string | null;
  rejections: number;
  review_window_seconds: number | null;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const TASK_SELECT = `
  select t.*, u.stellar_address as client_address, a.name as assigned_agent_name
  from tasks t
  join users u on u.id = t.client_id
  left join agents a on a.id = t.assigned_agent_id`;

export function assetFor(config: Config, code: string) {
  const asset = config.ASSETS.find((a) => a.code === code);
  if (!asset) throw badRequest(`unsupported asset ${code}`);
  return asset;
}

export function taskView(config: Config, row: TaskRow, opts: { includeSpec: boolean }) {
  const asset = config.ASSETS.find((a) => a.code === row.asset_code);
  return {
    id: row.id,
    onchainId: row.onchain_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    taskType: row.task_type,
    ...(opts.includeSpec ? { spec: row.spec } : {}),
    specSha256: row.spec_sha256,
    status: row.status,
    reward: {
      asset: row.asset_code,
      assetContract: row.asset_contract,
      amount: fromBaseUnits(BigInt(row.amount), asset?.decimals ?? 7),
      baseUnits: row.amount,
    },
    deadline: row.deadline.toISOString(),
    constraints: { maxDurationSeconds: row.max_duration_seconds },
    client: { id: row.client_id, address: row.client_address },
    assignedAgent: row.assigned_agent_id
      ? {
          id: row.assigned_agent_id,
          name: row.assigned_agent_name,
          payoutAddress: row.payee_address,
        }
      : null,
    rejections: row.rejections,
    reviewWindowSeconds: row.review_window_seconds,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    escrow: { contractId: config.ESCROW_CONTRACT_ID, network: config.STELLAR_NETWORK_PASSPHRASE },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function recordEvent(
  q: Db | Tx,
  e: {
    taskId: string;
    actor: { type: "user" | "agent" | "system" | "chain"; id?: string | null };
    action: string;
    from?: TaskStatus | null;
    to?: TaskStatus | null;
    detail?: Record<string, unknown>;
  },
) {
  await q.query(
    `insert into task_events (task_id, actor_type, actor_id, action, from_status, to_status, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.taskId,
      e.actor.type,
      e.actor.id ?? null,
      e.action,
      e.from ?? null,
      e.to ?? null,
      e.detail ?? {},
    ],
  );
}

export async function lockTask(tx: Tx, taskId: string): Promise<TaskRow> {
  const { rows } = await tx.query<TaskRow>(`${TASK_SELECT} where t.id = $1 for update of t`, [
    taskId,
  ]);
  if (!rows[0]) throw notFound("task");
  return rows[0];
}

export async function getTask(db: Db | Tx, taskId: string): Promise<TaskRow> {
  const { rows } = await db.query<TaskRow>(`${TASK_SELECT} where t.id = $1`, [taskId]);
  if (!rows[0]) throw notFound("task");
  return rows[0];
}

/** The caller's role on a task, or null if they have none. */
export function roleOn(config: Config, task: TaskRow, who: Principal): Role | null {
  if (who.kind === "agent") return task.assigned_agent_id === who.id ? "agent" : null;
  // A client is never the arbiter of their own task, even if the addresses match.
  if (who.id === task.client_id) return "client";
  if (who.address === config.ARBITER_ADDRESS) return "arbiter";
  return null;
}

// ---------------------------------------------------------------------------

export async function createTask(
  db: Db,
  config: Config,
  user: UserPrincipal,
  req: CreateTaskRequest,
) {
  const asset = assetFor(config, req.reward.asset);
  const amount = toBaseUnits(req.reward.amount, asset.decimals);
  const deadline = new Date(req.deadline);
  const now = Date.now();
  if (deadline.getTime() < now + 10 * 60_000)
    throw badRequest("deadline must be at least 10 minutes away");
  if (deadline.getTime() > now + 89 * 86_400_000)
    throw badRequest("deadline must be within 89 days");

  // Validate that the task can actually be executed before accepting it.
  try {
    runCsvAggregate(req.spec);
  } catch (e) {
    throw badRequest(`task input is not executable: ${(e as Error).message}`);
  }

  const onchainId = randomBytes(32).toString("hex");
  const specSha256 = await hashJson(req.spec);
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into tasks (onchain_id, client_id, title, description, acceptance_criteria, task_type,
         spec, spec_sha256, asset_code, asset_contract, amount, deadline, max_duration_seconds, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft') returning id`,
      [
        onchainId,
        user.id,
        req.title,
        req.description,
        req.acceptanceCriteria,
        req.spec.type,
        req.spec,
        specSha256,
        asset.code,
        asset.contractId,
        amount.toString(),
        deadline,
        req.constraints.maxDurationSeconds,
      ],
    );
    const id = (rows[0] as { id: string }).id;
    await recordEvent(tx, {
      taskId: id,
      actor: { type: "user", id: user.id },
      action: "create",
      to: "draft",
    });
    return getTask(tx, id);
  });
}

export async function listTasks(
  db: Db,
  config: Config,
  who: Principal | null,
  q: z.infer<typeof taskListQuery>,
) {
  const where: string[] = [];
  const args: unknown[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  if (q.mine === "client") {
    if (who?.kind !== "user") throw forbidden("sign in as a client to list your tasks");
    where.push(`t.client_id = ${arg(who.id)}`);
  } else if (q.mine === "agent") {
    if (who?.kind !== "agent") throw forbidden("authenticate as an agent to list its tasks");
    where.push(`t.assigned_agent_id = ${arg(who.id)}`);
  } else {
    // Drafts are private to their client.
    where.push(
      `(t.status <> 'draft' ${who?.kind === "user" ? `or t.client_id = ${arg(who.id)}` : ""})`,
    );
  }
  if (q.status) where.push(`t.status = ${arg(q.status)}`);
  if (q.taskType) where.push(`t.task_type = ${arg(q.taskType)}`);
  if (q.asset) where.push(`t.asset_code = ${arg(q.asset)}`);
  if (q.minReward) {
    const asset = assetFor(config, q.asset ?? config.ASSETS[0]?.code ?? "XLM");
    where.push(`t.amount >= ${arg(toBaseUnits(q.minReward, asset.decimals).toString())}`);
  }
  const { rows } = await db.query<TaskRow>(
    `${TASK_SELECT} where ${where.join(" and ")} order by t.created_at desc limit ${arg(q.limit)}`,
    args,
  );
  return rows.map((r) => taskView(config, r, { includeSpec: false }));
}

export async function cancelDraft(db: Db, user: UserPrincipal, taskId: string) {
  return withTx(db, async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.client_id !== user.id) throw forbidden("only the client can cancel this task");
    const inflight = await tx.query(
      "select 1 from chain_ops where task_id = $1 and status = 'submitted'",
      [taskId],
    );
    if (inflight.rowCount) throw conflict("TX_IN_FLIGHT", "a funding transaction is in flight");
    const to = applyOffchainOr409("cancel_draft", task.status, "client");
    await tx.query("update tasks set status = $2, updated_at = now() where id = $1", [taskId, to]);
    await tx.query(
      "update chain_ops set status = 'superseded', updated_at = now() where task_id = $1 and status = 'prepared'",
      [taskId],
    );
    await recordEvent(tx, {
      taskId,
      actor: { type: "user", id: user.id },
      action: "cancel_draft",
      from: task.status,
      to,
    });
    return getTask(tx, taskId);
  });
}

function applyOffchainOr409(
  action: Parameters<typeof applyOffchain>[0],
  status: TaskStatus,
  role: Role,
) {
  const err = checkAction(action, status, role);
  if (err)
    throw err.code === "FORBIDDEN"
      ? forbidden(err.message)
      : conflict("INVALID_STATE", err.message);
  return applyOffchain(action, status, role);
}

// ----- Applications -----------------------------------------------------------

export async function apply(db: Db, agent: AgentPrincipal, taskId: string, message: string) {
  const selectExisting = () =>
    db.query(
      "select id, task_id, agent_id, message, status, created_at from applications where task_id = $1 and agent_id = $2",
      [taskId, agent.id],
    );
  // Idempotent: applying again returns the existing application.
  const existing = await selectExisting();
  if (existing.rows[0]) return existing.rows[0];
  const task = await getTask(db, taskId);
  if (task.status !== "open") throw conflict("INVALID_STATE", `task is ${task.status}, not open`);
  if (!agent.capabilities.some((c) => c.taskType === task.task_type)) {
    throw forbidden(`agent has no ${task.task_type} capability`);
  }
  if (task.client_id === agent.operatorId)
    throw forbidden("an operator cannot apply to their own task");
  try {
    const { rows } = await db.query(
      `insert into applications (task_id, agent_id, message) values ($1, $2, $3)
       returning id, task_id, agent_id, message, status, created_at`,
      [taskId, agent.id, message],
    );
    await recordEvent(db, { taskId, actor: { type: "agent", id: agent.id }, action: "apply" });
    return rows[0];
  } catch (e) {
    if (isUniqueViolation(e)) return (await selectExisting()).rows[0];
    throw e;
  }
}

export async function listApplications(db: Db, who: Principal, taskId: string) {
  const task = await getTask(db, taskId);
  const isClient = who.kind === "user" && who.id === task.client_id;
  const { rows } = await db.query(
    `select ap.id, ap.agent_id, ag.name as agent_name, ag.payout_address, ag.description as agent_description,
            ap.message, ap.status, ap.created_at
     from applications ap join agents ag on ag.id = ap.agent_id
     where ap.task_id = $1 ${isClient ? "" : "and ap.agent_id = $2"} order by ap.created_at`,
    isClient
      ? [taskId]
      : [taskId, who.kind === "agent" ? who.id : "00000000-0000-0000-0000-000000000000"],
  );
  return rows;
}

// ----- Execution --------------------------------------------------------------

export async function startTask(db: Db, agent: AgentPrincipal, taskId: string) {
  return withTx(db, async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.assigned_agent_id !== agent.id) throw forbidden("task is not assigned to this agent");
    if (task.status === "in_progress") return task; // idempotent
    const to = applyOffchainOr409("start", task.status, "agent");
    await tx.query("update tasks set status = $2, updated_at = now() where id = $1", [taskId, to]);
    await recordEvent(tx, {
      taskId,
      actor: { type: "agent", id: agent.id },
      action: "start",
      from: task.status,
      to,
    });
    return getTask(tx, taskId);
  });
}

export async function recordRun(
  db: Db,
  agent: AgentPrincipal,
  taskId: string,
  e: { status: string; message: string; detail?: Record<string, unknown> | undefined },
) {
  const task = await getTask(db, taskId);
  const applied = await db.query(
    "select 1 from applications where task_id = $1 and agent_id = $2",
    [taskId, agent.id],
  );
  if (
    task.assigned_agent_id !== agent.id &&
    !applied.rowCount &&
    e.status !== "declined" &&
    e.status !== "evaluating"
  ) {
    throw forbidden("agent is not involved in this task");
  }
  await db.query(
    "insert into agent_runs (task_id, agent_id, status, message, detail) values ($1, $2, $3, $4, $5)",
    [taskId, agent.id, e.status, e.message, e.detail ?? {}],
  );
}

/**
 * Stores an agent's result, independently recomputes the expected output and
 * returns the digest the agent must record on-chain with `submit`.
 */
export async function createSubmission(
  db: Db,
  agent: AgentPrincipal,
  taskId: string,
  req: z.infer<typeof submissionRequest>,
) {
  const existing = await db.query(
    "select * from submissions where agent_id = $1 and idempotency_key = $2",
    [agent.id, req.idempotencyKey],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].task_id !== taskId)
      throw conflict("IDEMPOTENCY_KEY_REUSED", "key used for another task");
    return existing.rows[0];
  }

  const output = csvAggregateOutputSchema.parse(req.output);
  const outputSha256 = await hashJson(output);
  if (outputSha256 !== req.evidence.outputSha256) {
    throw badRequest("evidence.outputSha256 does not match the submitted output");
  }

  return withTx(db, async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.assigned_agent_id !== agent.id) throw forbidden("task is not assigned to this agent");
    const err = checkAction("submit", task.status, "agent");
    if (err) throw conflict("INVALID_STATE", err.message);
    if (req.evidence.specSha256 !== task.spec_sha256) {
      throw badRequest("evidence.specSha256 does not match the task specification");
    }

    const verification = await verify(task, outputSha256);
    const { rows: prev } = await tx.query<{ attempt: number }>(
      "select coalesce(max(attempt), 0) as attempt from submissions where task_id = $1",
      [taskId],
    );
    const attempt = (prev[0]?.attempt ?? 0) + 1;
    const digest = await submissionDigest({
      taskId,
      attempt,
      outputSha256,
      specSha256: task.spec_sha256,
    });
    // Earlier submissions that never reached the chain are superseded.
    await tx.query(
      "update submissions set status = 'superseded' where task_id = $1 and status = 'pending_chain'",
      [taskId],
    );
    const { rows } = await tx.query(
      `insert into submissions (task_id, agent_id, attempt, idempotency_key, output, evidence,
         output_sha256, digest, verification)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [
        taskId,
        agent.id,
        attempt,
        req.idempotencyKey,
        output,
        req.evidence,
        outputSha256,
        digest,
        verification,
      ],
    );
    await recordEvent(tx, {
      taskId,
      actor: { type: "agent", id: agent.id },
      action: "submission_received",
      detail: { attempt, matches: verification.matches },
    });
    return rows[0];
  });
}

/** Deterministic re-execution of the task, compared by output hash. */
async function verify(task: TaskRow, outputSha256: string) {
  const started = Date.now();
  try {
    const expected = runCsvAggregate(task.spec as Parameters<typeof runCsvAggregate>[0]);
    const expectedOutputSha256 = await hashJson(expected);
    return {
      method: "deterministic-recompute",
      matches: expectedOutputSha256 === outputSha256,
      expectedOutputSha256,
      outputSha256,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      method: "deterministic-recompute",
      matches: false,
      error: (e as Error).message,
      outputSha256,
      durationMs: Date.now() - started,
    };
  }
}

// ----- History ----------------------------------------------------------------

export async function taskHistory(db: Db, config: Config, who: Principal | null, taskId: string) {
  const task = await getTask(db, taskId);
  const role = who ? roleOn(config, task, who) : null;
  const [events, ops, submissions, reviews, disputes, runs] = await Promise.all([
    db.query(
      "select id, actor_type, actor_id, action, from_status, to_status, detail, created_at from task_events where task_id = $1 order by id",
      [taskId],
    ),
    db.query(
      `select id, action, contract_fn, signer, status, tx_hash, error, ledger, created_at, submitted_at, finished_at
       from chain_ops where task_id = $1 and status <> 'superseded' order by created_at`,
      [taskId],
    ),
    db.query(
      `select id, agent_id, attempt, status, output, evidence, output_sha256, digest, verification, created_at
       from submissions where task_id = $1 order by attempt`,
      [taskId],
    ),
    db.query(
      "select id, submission_id, decision, reason, created_at from reviews where task_id = $1 order by created_at",
      [taskId],
    ),
    db.query(
      `select id, opened_by_type, reason, status, payee_bps, resolution_reason, created_at, resolved_at
       from disputes where task_id = $1 order by created_at`,
      [taskId],
    ),
    db.query(
      "select id, agent_id, status, message, detail, created_at from agent_runs where task_id = $1 order by id",
      [taskId],
    ),
  ]);
  // Outputs are visible to the parties and the arbiter; others see hashes only.
  const canSeeOutput = role !== null;
  return {
    task: taskView(config, task, { includeSpec: true }),
    role,
    events: events.rows,
    chainOps: ops.rows,
    submissions: submissions.rows.map((s) => (canSeeOutput ? s : { ...s, output: undefined })),
    reviews: reviews.rows,
    disputes: disputes.rows,
    agentRuns: runs.rows,
  };
}
