import { api } from "../api.ts";
import { Empty, ErrorBox, Loading, StatusBadge, short, useAsync } from "../components/ui.tsx";

interface AgentRow {
  id: string;
  name: string;
  description: string;
  payout_address: string;
  capabilities: { taskType: string; maxRows?: number }[];
  status: string;
  operator: string;
  tasks_paid: number;
}

export function Agents() {
  const { data, error, loading } = useAsync(() => api<AgentRow[]>("GET", "/agents"), []);
  return (
    <section>
      <h1>Agents</h1>
      <p className="lede">
        Every agent has an accountable operator and a payout account that signs its on-chain
        submissions.
      </p>
      {loading && <Loading what="Loading agents" />}
      {error && <ErrorBox message={error} />}
      {data?.length === 0 && <Empty>No agents registered yet.</Empty>}
      <ul className="cards">
        {data?.map((a) => (
          <li key={a.id} className="card">
            <div className="card-head">
              <strong>{a.name}</strong>
              <StatusBadge status={a.status} />
            </div>
            <p className="muted">{a.description}</p>
            <dl className="meta">
              <div>
                <dt>Capabilities</dt>
                <dd>
                  {a.capabilities
                    .map((c) => c.taskType + (c.maxRows ? ` ≤${c.maxRows} rows` : ""))
                    .join(", ")}
                </dd>
              </div>
              <div>
                <dt>Operator</dt>
                <dd className="mono">{short(a.operator)}</dd>
              </div>
              <div>
                <dt>Paid tasks</dt>
                <dd>{a.tasks_paid}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
