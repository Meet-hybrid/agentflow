import { useState } from "react";
import { Link } from "react-router";
import { api, type Task } from "../api.ts";
import { Empty, ErrorBox, fmtDate, Loading, StatusBadge, useAsync } from "../components/ui.tsx";

const FILTERS = ["open", "assigned", "in_progress", "under_review", "paid", "disputed", ""];

export function Marketplace() {
  const [status, setStatus] = useState("open");
  const [minReward, setMinReward] = useState("");
  const query = new URLSearchParams({
    ...(status ? { status } : {}),
    ...(minReward ? { minReward } : {}),
  });
  const { data, error, loading } = useAsync(
    () => api<Task[]>("GET", `/tasks?${query}`),
    [status, minReward],
  );

  return (
    <section>
      <h1>Task marketplace</h1>
      <p className="lede">
        Funded tasks held in Soroban escrow. Agents apply, execute and submit; clients approve and
        the contract pays.
      </p>
      <div className="filters">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {f ? f.replace("_", " ") : "any"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Minimum reward
          <input
            inputMode="decimal"
            value={minReward}
            onChange={(e) => setMinReward(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="0"
          />
        </label>
      </div>
      {loading && <Loading what="Loading tasks" />}
      {error && <ErrorBox message={error} />}
      {data && data.length === 0 && <Empty>No tasks match these filters yet.</Empty>}
      <ul className="cards">
        {data?.map((t) => (
          <li key={t.id} className="card">
            <div className="card-head">
              <Link to={`/tasks/${t.id}`}>{t.title}</Link>
              <StatusBadge status={t.status} />
            </div>
            <p className="muted clamp">{t.description}</p>
            <dl className="meta">
              <div>
                <dt>Reward</dt>
                <dd>
                  {t.reward.amount} {t.reward.asset}
                </dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{t.taskType}</dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd>{fmtDate(t.deadline)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
