import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { api, type Task } from "../api.ts";
import {
  Empty,
  ErrorBox,
  ExplorerLink,
  fmtDate,
  Loading,
  StatusBadge,
  short,
  TxProgress,
  useAsync,
} from "../components/ui.tsx";
import { useSession } from "../session.tsx";
import { useChainOp } from "../useChainOp.ts";
import { ResultTable } from "./CreateTask.tsx";

interface History {
  task: Task;
  role: "client" | "agent" | "arbiter" | null;
  events: {
    id: string;
    actor_type: string;
    action: string;
    from_status: string | null;
    to_status: string | null;
    created_at: string;
  }[];
  chainOps: {
    id: string;
    action: string;
    status: string;
    tx_hash: string;
    signer: string;
    error: string | null;
    created_at: string;
    ledger: number | null;
  }[];
  submissions: {
    id: string;
    attempt: number;
    status: string;
    output?: { columns: string[]; rows: string[][]; inputRows: number };
    output_sha256: string;
    digest: string;
    verification: {
      matches: boolean;
      expectedOutputSha256?: string;
      error?: string;
      method: string;
    };
    created_at: string;
  }[];
  reviews: { id: string; decision: string; reason: string; created_at: string }[];
  disputes: {
    id: string;
    opened_by_type: string;
    reason: string;
    status: string;
    payee_bps: number | null;
    resolution_reason: string | null;
  }[];
  agentRuns: { id: string; status: string; message: string; created_at: string }[];
}

interface Application {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_description: string;
  payout_address: string;
  message: string;
  status: string;
}

const LIVE = new Set([
  "draft",
  "open",
  "assigned",
  "in_progress",
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "disputed",
]);

export function TaskDetail() {
  const { id = "" } = useParams();
  const { config, me } = useSession();
  const history = useAsync(() => api<History>("GET", `/tasks/${id}/history`), [id, me?.user.id]);
  const status = history.data?.task.status;

  // Keep the page current while the task is active (agents work asynchronously).
  useEffect(() => {
    if (!status || !LIVE.has(status)) return;
    const t = setInterval(() => void history.reload(), 8000);
    return () => clearInterval(t);
  }, [status, history.reload]);

  if (history.loading && !history.data) return <Loading what="Loading task" />;
  if (history.error && !history.data) return <ErrorBox message={history.error} />;
  if (!history.data || !config) return null;
  const { task, role } = history.data;
  const network = config.network;

  return (
    <article className="task">
      <header className="task-head">
        <div>
          <h1>{task.title}</h1>
          <p className="muted">
            Posted by <span className="mono">{short(task.client.address)}</span> ·{" "}
            {fmtDate(task.createdAt)}
            {role && (
              <>
                {" "}
                · you are the <strong>{role}</strong>
              </>
            )}
          </p>
        </div>
        <StatusBadge status={task.status} />
      </header>

      <section className="grid2">
        <div>
          <h2>Task</h2>
          <p className="prewrap">{task.description}</p>
          <h3>Acceptance criteria</h3>
          <p className="prewrap">{task.acceptanceCriteria}</p>
          {task.spec && (
            <>
              <h3>Specification ({task.taskType})</h3>
              <p className="muted">
                Group by <code>{task.spec.groupBy}</code>;{" "}
                {task.spec.metrics.map((m) => `${m.op}(${m.column})`).join(", ")};{" "}
                {task.spec.decimals} decimals; {task.spec.csv.split("\n").length - 2} data rows.
              </p>
              <details>
                <summary>Input CSV</summary>
                <pre className="mono scroll">{task.spec.csv.slice(0, 5000)}</pre>
              </details>
            </>
          )}
        </div>
        <aside className="panel">
          <h2>Escrow</h2>
          <dl className="meta stacked">
            <div>
              <dt>Reward</dt>
              <dd>
                {task.reward.amount} {task.reward.asset}
              </dd>
            </div>
            <div>
              <dt>Submission deadline</dt>
              <dd>{fmtDate(task.deadline)}</dd>
            </div>
            <div>
              <dt>Contract</dt>
              <dd>
                <ExplorerLink kind="contract" id={task.escrow.contractId} network={network} />
              </dd>
            </div>
            <div>
              <dt>Task id on-chain</dt>
              <dd className="mono">{short(task.onchainId, 8)}</dd>
            </div>
            {task.assignedAgent && (
              <div>
                <dt>Assigned agent</dt>
                <dd>
                  {task.assignedAgent.name} (
                  <span className="mono">{short(task.assignedAgent.payoutAddress)}</span>)
                </dd>
              </div>
            )}
            {task.reviewWindowSeconds !== null && (
              <div>
                <dt>Review window</dt>
                <dd>{Math.round(task.reviewWindowSeconds / 60)} min after submission</dd>
              </div>
            )}
          </dl>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              api("POST", `/tasks/${task.id}/sync`).then(history.reload, () => history.reload())
            }
            disabled={!me}
          >
            Refresh from chain
          </button>
        </aside>
      </section>

      {me && role && (
        <Actions
          task={task}
          role={role}
          history={history.data}
          reload={history.reload}
          network={network}
        />
      )}

      <Submissions history={history.data} />
      <Timeline history={history.data} network={network} />
    </article>
  );
}

function Actions({
  task,
  role,
  history,
  reload,
  network,
}: {
  task: Task;
  role: string;
  history: History;
  reload: () => Promise<void>;
  network: string;
}) {
  const op = useChainOp(
    task.id,
    useCallback(() => void reload(), [reload]),
  );
  const [reason, setReason] = useState("");
  const [bps, setBps] = useState(5000);
  const apps = useAsync(
    () =>
      role === "client" && task.status === "open"
        ? api<Application[]>("GET", `/tasks/${task.id}/applications`)
        : Promise.resolve([]),
    [task.id, task.status, role],
  );
  const pastDeadline = Date.now() > new Date(task.deadline).getTime();
  const s = task.status;
  const needReason = (fn: () => void) => () =>
    reason.trim() ? fn() : alert("Please give a reason.");

  return (
    <section className="panel actions">
      <h2>Actions</h2>
      <TxProgress step={op.step} error={op.error} txHash={op.op?.txHash} network={network} />

      {role === "client" && s === "draft" && (
        <div className="btns">
          <button type="button" onClick={() => op.run({ action: "fund" })} disabled={op.busy}>
            Fund escrow ({task.reward.amount} {task.reward.asset})
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => api("POST", `/tasks/${task.id}/cancel`).then(reload)}
            disabled={op.busy}
          >
            Cancel draft
          </button>
        </div>
      )}

      {role === "client" && s === "open" && (
        <>
          <h3>Applications</h3>
          {apps.loading && <Loading what="Loading applications" />}
          {apps.data?.length === 0 && (
            <Empty>No agent has applied yet. Agents poll for open tasks automatically.</Empty>
          )}
          <ul className="list">
            {apps.data?.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>{a.agent_name}</strong>{" "}
                  <span className="mono muted">{short(a.payout_address)}</span>
                  <p className="muted">{a.message || a.agent_description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => op.run({ action: "accept_application", applicationId: a.id })}
                  disabled={op.busy || a.status !== "pending"}
                >
                  Assign
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="ghost"
            onClick={() => op.run({ action: "refund" })}
            disabled={op.busy}
          >
            Cancel and refund
          </button>
        </>
      )}

      {role === "client" && ["assigned", "in_progress", "rejected"].includes(s) && (
        <div className="btns">
          <button
            type="button"
            className="ghost"
            onClick={() => op.run({ action: "refund" })}
            disabled={op.busy || !pastDeadline}
          >
            Refund {pastDeadline ? "" : "(after the deadline)"}
          </button>
        </div>
      )}

      {role === "client" && ["submitted", "under_review"].includes(s) && (
        <>
          <p>
            Review the latest submission below. Approving releases the full reward to the agent.
          </p>
          <div className="btns">
            <button type="button" onClick={() => op.run({ action: "approve" })} disabled={op.busy}>
              Approve and release payment
            </button>
          </div>
        </>
      )}

      {(role === "client" || role === "agent") &&
        ["assigned", "in_progress", "rejected", "submitted", "under_review"].includes(s) && (
          <div className="reasoned">
            <label>
              Reason (required to reject or dispute)
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={2000}
              />
            </label>
            <div className="btns">
              {role === "client" && ["submitted", "under_review"].includes(s) && (
                <button
                  type="button"
                  className="ghost"
                  onClick={needReason(() => op.run({ action: "reject", reason }))}
                  disabled={op.busy}
                >
                  Reject submission
                </button>
              )}
              <button
                type="button"
                className="ghost danger"
                onClick={needReason(() => op.run({ action: "dispute", reason }))}
                disabled={op.busy}
              >
                Open dispute
              </button>
            </div>
          </div>
        )}

      {role === "arbiter" && s === "disputed" && (
        <div className="reasoned">
          {history.disputes
            .filter((d) => d.status === "open")
            .map((d) => (
              <p key={d.id}>
                Opened by {d.opened_by_type}: <q>{d.reason}</q>
              </p>
            ))}
          <label>
            Agent receives {(bps / 100).toFixed(2)}%, client {((10000 - bps) / 100).toFixed(2)}%
            <input
              type="range"
              min={0}
              max={10000}
              step={100}
              value={bps}
              onChange={(e) => setBps(Number(e.target.value))}
            />
          </label>
          <label>
            Ruling
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </label>
          <button
            type="button"
            onClick={needReason(() => op.run({ action: "resolve", payeeBps: bps, reason }))}
            disabled={op.busy}
          >
            Resolve dispute
          </button>
        </div>
      )}

      {["paid", "resolved", "refunded", "cancelled"].includes(s) && (
        <p className="muted">This task is closed.</p>
      )}
      {s === "approved" && <p className="muted">Payment release is being confirmed on Stellar.</p>}
    </section>
  );
}

function Submissions({ history }: { history: History }) {
  if (!history.submissions.length) return null;
  return (
    <section>
      <h2>Submissions</h2>
      {[...history.submissions].reverse().map((s) => (
        <div key={s.id} className="panel">
          <div className="card-head">
            <strong>Attempt {s.attempt}</strong>
            <StatusBadge status={s.status} />
          </div>
          <p className={s.verification.matches ? "ok-text" : "error-text"}>
            {s.verification.matches
              ? "Verified: matches an independent deterministic recomputation."
              : `Does not match recomputation${s.verification.error ? ` (${s.verification.error})` : ""}.`}
          </p>
          <p className="muted small">
            Output sha256 <span className="mono">{short(s.output_sha256, 10)}</span> · on-chain
            evidence <span className="mono">{short(s.digest, 10)}</span>
          </p>
          {s.output ? (
            <ResultTable columns={s.output.columns} rows={s.output.rows.slice(0, 50)} />
          ) : (
            <p className="muted">Output is visible to the task's parties.</p>
          )}
        </div>
      ))}
    </section>
  );
}

function Timeline({ history, network }: { history: History; network: string }) {
  return (
    <section className="grid2">
      <div>
        <h2>Transactions</h2>
        {history.chainOps.length === 0 && <Empty>No escrow transactions yet.</Empty>}
        <ul className="list">
          {history.chainOps.map((o) => (
            <li key={o.id}>
              <div>
                <strong>{o.action.replace("_", " ")}</strong> <StatusBadge status={o.status} />
                <p className="muted small">
                  <ExplorerLink kind="tx" id={o.tx_hash} network={network} /> · signer{" "}
                  {short(o.signer)}
                  {o.ledger ? ` · ledger ${o.ledger}` : ""}
                  {o.error ? ` · ${o.error}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <h2>Reviews and disputes</h2>
        {history.reviews.length + history.disputes.length === 0 && <Empty>None.</Empty>}
        <ul className="list">
          {history.reviews.map((r) => (
            <li key={r.id}>
              <span>
                <StatusBadge status={r.decision} /> {r.reason}
              </span>
            </li>
          ))}
          {history.disputes.map((d) => (
            <li key={d.id}>
              <span>
                Dispute ({d.status}) by {d.opened_by_type}: {d.reason}
                {d.payee_bps !== null && ` → agent ${d.payee_bps / 100}%: ${d.resolution_reason}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h2>Agent execution log</h2>
        {history.agentRuns.length === 0 && <Empty>No agent activity yet.</Empty>}
        <ol className="log">
          {history.agentRuns.map((r) => (
            <li key={r.id}>
              <time>{fmtDate(r.created_at)}</time> <strong>{r.status}</strong> {r.message}
            </li>
          ))}
        </ol>
        <h2>History</h2>
        <ol className="log">
          {history.events.map((e) => (
            <li key={e.id}>
              <time>{fmtDate(e.created_at)}</time> {e.actor_type} · {e.action.replaceAll("_", " ")}
              {e.to_status && e.to_status !== e.from_status && ` → ${e.to_status}`}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
