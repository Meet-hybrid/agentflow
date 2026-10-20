/**
 * The reference agent runtime.
 *
 * Each pass:
 *  1. continues work on tasks assigned to this agent (execute, submit, react
 *     to rejections, claim after the review window);
 *  2. discovers open tasks, evaluates them against its executors, limits and
 *     policy, and applies to the ones it can safely do.
 *
 * Every escrow transaction the API prepares is decoded and checked before the
 * agent signs it with its payout key (see assertEscrowTx).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEscrowTx, inspectEscrowTx, toBaseUnits } from "@agentflow/stellar";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { ApiClient, ApiRequestError } from "./api-client.ts";
import { EXECUTORS, type TaskExecutor } from "./executors/index.ts";
import { SandboxError } from "./sandbox.ts";

export interface AgentConfig {
  apiUrl: string;
  apiKey: string;
  payoutSecret: string;
  /** Minimum reward to apply for, in the task's asset units (e.g. "1.5"). */
  minReward: string;
  stateDir: string;
  maxExecutionAttempts: number;
  /** Highest network fee the agent will sign, in stroops. */
  maxFeeStroops: bigint;
  log?: (entry: Record<string, unknown>) => void;
}

interface Task {
  id: string;
  onchainId: string;
  title: string;
  taskType: string;
  spec?: unknown;
  status: string;
  reward: { asset: string; amount: string };
  deadline: string;
  constraints: { maxDurationSeconds: number };
  rejections: number;
  reviewWindowSeconds: number | null;
  submittedAt: string | null;
  client: { address: string };
}

interface ChainOp {
  id: string;
  status: string;
  xdr?: string;
  txHash: string;
  error?: string | null;
}

interface State {
  applied: Record<string, string>;
  declined: Record<string, string[]>;
  attempts: Record<string, number>;
  disputed: Record<string, string>;
}

const TERMINAL = new Set(["paid", "resolved", "refunded", "cancelled"]);

export class ReferenceAgent {
  private readonly api: ApiClient;
  private readonly keypair: Keypair;
  private readonly cfg: AgentConfig;
  private state: State = { applied: {}, declined: {}, attempts: {}, disputed: {} };
  private network = "";
  private escrowContract = "";
  private capabilities: { taskType: string; maxRows?: number }[] = [];
  readonly log: (entry: Record<string, unknown>) => void;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    this.api = new ApiClient({ baseUrl: cfg.apiUrl, token: cfg.apiKey });
    this.keypair = Keypair.fromSecret(cfg.payoutSecret);
    this.log =
      cfg.log ?? ((e) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`));
  }

  /** Loads identity and network configuration; fails fast on mismatches. */
  async init() {
    const me = await this.api.get<{ kind: string; agent: { id: string; name: string; payout_address: string; capabilities: { taskType: string; maxRows?: number }[] } }>("/me");
    if (me.kind !== "agent") throw new Error("AGENTFLOW_AGENT_KEY is not an agent API key");
    if (me.agent.payout_address !== this.keypair.publicKey()) {
      throw new Error(
        `payout key ${this.keypair.publicKey()} does not match the registered payout address ${me.agent.payout_address}`,
      );
    }
    const config = await this.api.get<{ network: string; escrowContractId: string }>("/config");
    this.network = config.network;
    this.escrowContract = config.escrowContractId;
    this.capabilities = me.agent.capabilities;
    await this.loadState();
    this.log({ level: "info", event: "agent_ready", agent: me.agent.name, payout: me.agent.payout_address });
  }

  async runOnce() {
    const mine = await this.api.get<Task[]>("/tasks?mine=agent&limit=100");
    for (const task of mine) {
      if (TERMINAL.has(task.status)) continue;
      await this.guard(task.id, () => this.continueTask(task));
    }
    const open = await this.api.get<Task[]>("/tasks?status=open&taskType=csv-aggregate&limit=50");
    for (const task of open) {
      if (this.state.applied[task.id] || this.state.declined[task.id]) continue;
      await this.guard(task.id, () => this.consider(task));
    }
  }

  async runForever(pollSeconds: number, signal?: AbortSignal) {
    while (!signal?.aborted) {
      try {
        await this.runOnce();
      } catch (e) {
        this.log({ level: "error", event: "pass_failed", error: String(e) });
      }
      await new Promise((r) => setTimeout(r, pollSeconds * 1000));
    }
  }

  // ----- Discovery -----------------------------------------------------------

  private async consider(summary: Task) {
    const task = await this.api.get<Task>(`/tasks/${summary.id}`);
    const executor = EXECUTORS[task.taskType];
    const reasons: string[] = [];
    if (!executor || !this.capabilities.some((c) => c.taskType === task.taskType)) {
      reasons.push(`unsupported task type ${task.taskType}`);
    }
    try {
      if (toBaseUnits(task.reward.amount) < toBaseUnits(this.cfg.minReward)) {
        reasons.push(`reward ${task.reward.amount} below minimum ${this.cfg.minReward}`);
      }
    } catch {
      reasons.push("unreadable reward");
    }
    const margin = task.constraints.maxDurationSeconds * 1000 + 15 * 60_000;
    if (new Date(task.deadline).getTime() - Date.now() < margin) reasons.push("deadline too close");
    if (executor) {
      const limit = this.capabilities.find((c) => c.taskType === task.taskType);
      reasons.push(...executor.evaluate(task.spec, { maxRows: limit?.maxRows }).reasons);
    }

    await this.run(task.id, "evaluating", `evaluated "${task.title}"`, { reasons });
    if (reasons.length) {
      this.state.declined[task.id] = reasons;
      await this.saveState();
      this.log({ level: "info", event: "declined", taskId: task.id, reasons });
      return;
    }
    await this.api.post(`/tasks/${task.id}/applications`, {
      message: `Reference agent: deterministic ${task.taskType} executor (${executor?.id}).`,
    });
    this.state.applied[task.id] = new Date().toISOString();
    await this.saveState();
    await this.run(task.id, "accepted", "applied to task");
    this.log({ level: "info", event: "applied", taskId: task.id });
  }

  // ----- Work ------------------------------------------------------------------

  private async continueTask(task: Task) {
    switch (task.status) {
      case "assigned":
      case "in_progress":
        return this.execute(task);
      case "rejected":
        return this.onRejected(task);
      case "submitted":
      case "under_review":
        return this.maybeClaim(task);
      default:
        return; // approved (release in flight), disputed: nothing to do
    }
  }

  private async execute(summary: Task) {
    if (summary.status === "assigned") await this.api.post(`/tasks/${summary.id}/start`);
    const task = await this.api.get<Task>(`/tasks/${summary.id}`);
    const executor = EXECUTORS[task.taskType] as TaskExecutor;
    const key = `${task.id}:r${task.rejections}`;
    const attempts = (this.state.attempts[key] ?? 0) + 1;
    this.state.attempts[key] = attempts;
    await this.saveState();

    await this.run(task.id, "executing", `executing attempt ${attempts}`);
    let result: Awaited<ReturnType<TaskExecutor["execute"]>>;
    try {
      result = await executor.execute(task.spec, { timeoutMs: task.constraints.maxDurationSeconds * 1000 });
    } catch (e) {
      const kind = e instanceof SandboxError ? e.kind : "crashed";
      await this.run(task.id, "failed", (e as Error).message, { kind, attempt: attempts });
      this.log({ level: "warn", event: "execution_failed", taskId: task.id, kind, error: (e as Error).message });
      // Invalid input never succeeds; transient failures are retried a few times.
      if (kind === "task_error" || attempts >= this.cfg.maxExecutionAttempts) {
        await this.chainOp(task, { action: "abandon" }, "abandon");
        await this.run(task.id, "declined", "abandoned the task after execution failures");
      }
      return;
    }
    await this.run(task.id, "succeeded", `computed ${countRows(result.output)} output rows`, {
      outputSha256: result.evidence.outputSha256,
      durationMs: result.evidence.durationMs,
    });

    // The idempotency key is stable per (task, rejection round), so a retry
    // after a crash returns the same submission instead of creating another.
    const submission = await this.api.post<{ id: string; status: string; verification: { matches: boolean } }>(
      `/tasks/${task.id}/submissions`,
      { idempotencyKey: key, output: result.output, evidence: result.evidence },
    );
    if (!submission.verification.matches) {
      await this.run(task.id, "failed", "platform recomputation disagrees with this output; not submitting");
      this.log({ level: "error", event: "verification_mismatch", taskId: task.id });
      return;
    }
    if (submission.status !== "pending_chain") return; // already recorded on-chain
    const op = await this.chainOp(task, { action: "submit", submissionId: submission.id }, "submit");
    if (op?.status === "confirmed") {
      await this.run(task.id, "submitted", "submission recorded on-chain", { txHash: op.txHash });
      this.log({ level: "info", event: "submitted", taskId: task.id, txHash: op.txHash });
    }
  }

  private async onRejected(task: Task) {
    const history = await this.api.get<{
      submissions: { status: string; verification: { matches: boolean } }[];
      reviews: { decision: string; reason: string }[];
    }>(`/tasks/${task.id}/history`);
    const last = history.submissions.filter((s) => s.status === "rejected").at(-1);
    const reason = history.reviews.filter((r) => r.decision === "rejected").at(-1)?.reason ?? "";
    this.log({ level: "info", event: "rejected", taskId: task.id, reason });
    if (last?.verification.matches && !this.state.disputed[task.id]) {
      // Deterministic output that matches recomputation: resubmitting the same
      // result is pointless, so ask the arbiter instead.
      const op = await this.chainOp(
        task,
        {
          action: "dispute",
          reason: `Rejected with "${reason.slice(0, 300)}", but the output matches the platform's deterministic recomputation.`,
        },
        "dispute",
      );
      if (op?.status === "confirmed") {
        this.state.disputed[task.id] = op.txHash;
        await this.saveState();
        await this.run(task.id, "submitted", "opened a dispute", { txHash: op.txHash });
      }
      return;
    }
    if (!this.state.disputed[task.id]) await this.execute(task);
  }

  private async maybeClaim(task: Task) {
    if (!task.submittedAt || !task.reviewWindowSeconds) return;
    const due = new Date(task.submittedAt).getTime() + (task.reviewWindowSeconds + 30) * 1000;
    if (Date.now() < due) return;
    const op = await this.chainOp(task, { action: "claim" }, "claim");
    if (op?.status === "confirmed") {
      await this.run(task.id, "submitted", "claimed payment after the review window", { txHash: op.txHash });
    }
  }

  // ----- Chain operations --------------------------------------------------------

  /** Prepares, inspects, signs and submits a transaction, then waits for it. */
  private async chainOp(task: Task, request: Record<string, unknown>, fn: string): Promise<ChainOp | null> {
    let op: ChainOp;
    try {
      op = await this.api.post<ChainOp>(`/tasks/${task.id}/chain-ops`, request);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 409) {
        this.log({ level: "info", event: "chain_op_deferred", taskId: task.id, fn, reason: e.code });
        return null;
      }
      throw e;
    }
    if (!op.xdr) return op;
    assertEscrowTx(inspectEscrowTx(op.xdr, this.network), {
      contractId: this.escrowContract,
      fn,
      taskId: task.onchainId,
      source: this.keypair.publicKey(),
      maxFee: this.cfg.maxFeeStroops,
    });
    const tx = TransactionBuilder.fromXDR(op.xdr, this.network);
    tx.sign(this.keypair);
    let current = await this.api.post<ChainOp>(`/chain-ops/${op.id}/signed`, { signedXdr: tx.toXdr() });
    const until = Date.now() + 120_000;
    while (current.status === "submitted" && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      current = await this.api.get<ChainOp>(`/chain-ops/${op.id}`);
    }
    this.log({ level: current.status === "confirmed" ? "info" : "warn", event: "chain_op", taskId: task.id, fn, status: current.status, txHash: current.txHash, error: current.error ?? undefined });
    return current;
  }

  // ----- Helpers -----------------------------------------------------------------

  private async guard(taskId: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.log({ level: "error", event: "task_error", taskId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async run(taskId: string, status: string, message: string, detail?: Record<string, unknown>) {
    await this.api.post(`/tasks/${taskId}/runs`, { status, message, detail }).catch(() => {});
  }

  private get statePath() {
    return join(this.cfg.stateDir, "state.json");
  }

  private async loadState() {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    try {
      this.state = { ...this.state, ...JSON.parse(await readFile(this.statePath, "utf8")) };
    } catch {
      // first run
    }
  }

  private async saveState() {
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(tmp, this.statePath);
  }
}

function countRows(output: unknown): number {
  return Array.isArray((output as { rows?: unknown[] })?.rows) ? (output as { rows: unknown[] }).rows.length : 0;
}
