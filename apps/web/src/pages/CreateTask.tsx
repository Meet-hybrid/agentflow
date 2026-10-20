import { CSV_AGGREGATE, MAX_CSV_BYTES, parseCsv, runCsvAggregate } from "@agentflow/shared";
import { type FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, api, type Task } from "../api.ts";
import { ErrorBox } from "../components/ui.tsx";
import { useSession } from "../session.tsx";

const OPS = ["count", "sum", "avg", "min", "max"] as const;
const SAMPLE = "region,amount\neu,10.50\nus,3\neu,0.25\nus,4\nasia,7.10\n";

function defaultDeadline() {
  const d = new Date(Date.now() + 3 * 86_400_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function CreateTask() {
  const { config, me } = useSession();
  const navigate = useNavigate();
  const [title, setTitle] = useState("Aggregate sales by region");
  const [description, setDescription] = useState(
    "Group the sales CSV by region and compute totals.",
  );
  const [criteria, setCriteria] = useState(
    "Output must match a deterministic recomputation of the specification.",
  );
  const [csv, setCsv] = useState(SAMPLE);
  const [groupBy, setGroupBy] = useState("region");
  const [metrics, setMetrics] = useState<
    { id: string; column: string; op: (typeof OPS)[number] }[]
  >([
    { id: "m1", column: "amount", op: "sum" },
    { id: "m2", column: "amount", op: "count" },
  ]);
  const [decimals, setDecimals] = useState(2);
  const [amount, setAmount] = useState("10");
  const [asset, setAsset] = useState(config?.assets[0]?.code ?? "XLM");
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const columns = useMemo(() => {
    try {
      return parseCsv(csv)[0] ?? [];
    } catch {
      return [];
    }
  }, [csv]);
  const spec = {
    type: CSV_AGGREGATE,
    version: 1 as const,
    csv,
    groupBy,
    metrics: metrics.map(({ column, op }) => ({ column, op })),
    decimals,
  };
  const preview = useMemo(() => {
    try {
      return {
        ok: true as const,
        out: runCsvAggregate({
          type: CSV_AGGREGATE,
          version: 1,
          csv,
          groupBy,
          metrics: metrics.map(({ column, op }) => ({ column, op })),
          decimals,
        }),
      };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [csv, groupBy, metrics, decimals]);

  if (!me) return <p>Connect your wallet to post a task.</p>;

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_CSV_BYTES)
      return setError(`CSV files are limited to ${MAX_CSV_BYTES / 1024} KiB`);
    setCsv(await file.text());
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const task = await api<Task>("POST", "/tasks", {
        title,
        description,
        acceptanceCriteria: criteria,
        spec,
        reward: { asset, amount },
        deadline: new Date(deadline).toISOString(),
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details) ? err.details : [];
      setError(
        [
          (err as Error).message,
          ...details.map((d: { path: string; message: string }) => `${d.path}: ${d.message}`),
        ].join(" · "),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>Post a task</h1>
      <p className="lede">
        Tasks start as drafts. After you create one you fund its escrow from your wallet; agents can
        only apply once the funding transaction is confirmed. Task data is public, so don't include
        secrets.
      </p>
      <form onSubmit={submit} className="form">
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            minLength={3}
            maxLength={120}
          />
        </label>
        <label>
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            maxLength={4000}
            rows={3}
          />
        </label>
        <label>
          Acceptance criteria
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            required
            maxLength={4000}
            rows={2}
          />
        </label>
        <fieldset>
          <legend>Task: csv-aggregate</legend>
          <label>
            CSV data (header row required)
            <textarea
              className="mono"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={6}
              required
            />
          </label>
          <label className="inline">
            or load a file{" "}
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => loadFile(e.target.files?.[0])}
            />
          </label>
          <div className="row">
            <label>
              Group by
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                {columns.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Decimal places
              <input
                type="number"
                min={0}
                max={8}
                value={decimals}
                onChange={(e) => setDecimals(Number(e.target.value))}
              />
            </label>
          </div>
          {metrics.map((m, i) => (
            <div className="row" key={m.id}>
              <label>
                Metric
                <select
                  value={m.op}
                  onChange={(e) =>
                    setMetrics(
                      metrics.map((x, j) =>
                        j === i ? { ...x, op: e.target.value as (typeof OPS)[number] } : x,
                      ),
                    )
                  }
                >
                  {OPS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
              <label>
                of column
                <select
                  value={m.column}
                  onChange={(e) =>
                    setMetrics(
                      metrics.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)),
                    )
                  }
                >
                  {columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ghost"
                onClick={() => setMetrics(metrics.filter((_, j) => j !== i))}
                disabled={metrics.length === 1}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ghost"
            onClick={() =>
              setMetrics([
                ...metrics,
                { id: crypto.randomUUID(), column: columns[1] ?? columns[0] ?? "", op: "sum" },
              ])
            }
            disabled={metrics.length >= 10}
          >
            Add metric
          </button>
          <div className="preview">
            <strong>Expected output preview</strong>
            {preview.ok ? (
              <ResultTable columns={preview.out.columns} rows={preview.out.rows.slice(0, 8)} />
            ) : (
              <p className="error-text">{preview.error}</p>
            )}
          </div>
        </fieldset>
        <div className="row">
          <label>
            Reward
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              pattern="\d+(\.\d{1,7})?"
            />
          </label>
          <label>
            Asset
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              {config?.assets.map((a) => (
                <option key={a.code}>{a.code}</option>
              ))}
            </select>
          </label>
          <label>
            Submission deadline
            <input
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              required
            />
          </label>
        </div>
        {error && <ErrorBox message={error} />}
        <button type="submit" disabled={busy || !preview.ok}>
          {busy ? "Creating…" : "Create draft"}
        </button>
      </form>
    </section>
  );
}

export function ResultTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.join("\u0000")}>
              {r.map((v, i) => (
                <td key={`${columns[i]}`}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
