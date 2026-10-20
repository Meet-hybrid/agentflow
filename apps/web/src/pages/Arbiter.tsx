import { Link } from "react-router";
import { api } from "../api.ts";
import { Empty, ErrorBox, fmtDate, Loading, useAsync } from "../components/ui.tsx";
import { useSession } from "../session.tsx";

export function Arbiter() {
  const { me } = useSession();
  const { data, error, loading } = useAsync(
    () =>
      me?.user.isArbiter
        ? api<
            {
              id: string;
              task_id: string;
              title: string;
              reason: string;
              opened_by_type: string;
              created_at: string;
            }[]
          >("GET", "/arbiter/disputes")
        : Promise.resolve([]),
    [me?.user.isArbiter],
  );
  if (!me?.user.isArbiter) return <p>Only the configured arbiter can see the dispute queue.</p>;
  return (
    <section>
      <h1>Open disputes</h1>
      <p className="lede">
        Rule against the task's acceptance criteria, the submitted output and the platform's
        verification report. A ruling splits the escrow between agent and client; it is final.
      </p>
      {loading && <Loading />}
      {error && <ErrorBox message={error} />}
      {data?.length === 0 && <Empty>No open disputes.</Empty>}
      <ul className="list">
        {data?.map((d) => (
          <li key={d.id}>
            <span>
              <Link to={`/tasks/${d.task_id}`}>{d.title}</Link> · opened by {d.opened_by_type}{" "}
              {fmtDate(d.created_at)}
              <br />
              <q className="muted">{d.reason}</q>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
