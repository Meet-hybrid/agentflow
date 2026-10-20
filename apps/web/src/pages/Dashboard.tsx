import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { api, type Task } from "../api.ts";
import { Empty, ErrorBox, Loading, StatusBadge, short, useAsync } from "../components/ui.tsx";
import { useSession } from "../session.tsx";

export function Dashboard() {
  const { me, refreshMe } = useSession();
  const tasks = useAsync(() => api<Task[]>("GET", "/tasks?mine=client&limit=100"), [me?.user.id]);
  if (!me) return <p>Connect your wallet to see your dashboard.</p>;

  return (
    <section>
      <h1>Dashboard</h1>
      <h2>Your tasks</h2>
      {tasks.loading && <Loading what="Loading your tasks" />}
      {tasks.error && <ErrorBox message={tasks.error} />}
      {tasks.data?.length === 0 && (
        <Empty>
          You haven't posted a task yet. <Link to="/tasks/new">Post one</Link>.
        </Empty>
      )}
      <ul className="list">
        {tasks.data?.map((t) => (
          <li key={t.id}>
            <Link to={`/tasks/${t.id}`}>{t.title}</Link>
            <span>
              {t.reward.amount} {t.reward.asset} <StatusBadge status={t.status} />
            </span>
          </li>
        ))}
      </ul>

      <h2>Your agents</h2>
      {me.agents.length === 0 && (
        <Empty>You operate no agents. Register one below to run the reference agent.</Empty>
      )}
      <ul className="list">
        {me.agents.map((a) => (
          <li key={a.id}>
            <span>
              <strong>{a.name}</strong>{" "}
              <span className="mono muted">{short(a.payout_address)}</span>
            </span>
            <StatusBadge status={a.status} />
          </li>
        ))}
      </ul>
      <RegisterAgent onDone={refreshMe} />
    </section>
  );
}

function RegisterAgent({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [payout, setPayout] = useState("");
  const [maxRows, setMaxRows] = useState(5000);
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ apiKey: string }>("POST", "/agents", {
        name,
        payoutAddress: payout.trim(),
        description: "AgentFlow reference agent",
        capabilities: [{ taskType: "csv-aggregate", maxRows }],
      });
      setKey(res.apiKey);
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="form panel" onSubmit={submit}>
      <h3>Register an agent</h3>
      <p className="muted">
        You are the accountable operator. The payout account receives rewards and must sign the
        agent's on-chain submissions; use a separate account from your client wallet.
      </p>
      <div className="row">
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={3}
            maxLength={60}
          />
        </label>
        <label>
          Payout account (G…)
          <input
            className="mono"
            value={payout}
            onChange={(e) => setPayout(e.target.value)}
            required
            pattern="G[A-Z2-7]{55}"
          />
        </label>
        <label>
          Max rows
          <input
            type="number"
            min={1}
            max={10000}
            value={maxRows}
            onChange={(e) => setMaxRows(Number(e.target.value))}
          />
        </label>
      </div>
      {error && <ErrorBox message={error} />}
      {key && (
        <div className="alert success">
          API key (shown once; store it securely): <code className="mono break">{key}</code>
        </div>
      )}
      <button type="submit">Register agent</button>
    </form>
  );
}
