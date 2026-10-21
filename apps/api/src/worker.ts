/**
 * Background reconciliation:
 *  - polls submitted transactions until the network gives a final answer;
 *  - expires prepared transactions nobody signed;
 *  - indexes escrow events and re-syncs the tasks they mention;
 *  - periodically re-syncs every non-terminal task from the contract.
 */
import type { EscrowClient } from "@agentflow/stellar";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "./db/pool.ts";
import { type ChainGateway, type ChainOpRow, pollOp, syncTask } from "./services/chain.ts";

export interface WorkerDeps {
  db: Db;
  chain: ChainGateway;
  events?: Pick<EscrowClient, "events" | "latestLedger">;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
}

export async function pollSubmittedOps({ db, chain }: WorkerDeps) {
  const { rows } = await db.query<ChainOpRow>(
    "select * from chain_ops where status = 'submitted' order by submitted_at limit 50",
  );
  let finished = 0;
  for (const op of rows) if (await pollOp(db, chain, op)) finished++;
  return { checked: rows.length, finished };
}

export async function expirePreparedOps({ db }: WorkerDeps) {
  const { rowCount } = await db.query(
    "update chain_ops set status = 'expired', finished_at = now(), updated_at = now() where status = 'prepared' and max_time < now()",
  );
  return rowCount ?? 0;
}

export async function reconcileTasks({ db, chain, log }: WorkerDeps, staleSeconds = 60) {
  const { rows } = await db.query<{ id: string }>(
    `select id from tasks
     where status not in ('paid', 'resolved', 'refunded', 'cancelled')
       and (last_synced_at is null or last_synced_at < now() - make_interval(secs => $1))
     order by last_synced_at nulls first limit 25`,
    [staleSeconds],
  );
  for (const { id } of rows) {
    await syncTask(db, chain, id).catch((e: unknown) =>
      log.warn({ taskId: id, err: String(e) }, "sync failed"),
    );
  }
  return rows.length;
}

export async function indexEvents({ db, chain, events, log }: WorkerDeps) {
  if (!events) return 0;
  const { rows } = await db.query<{ cursor: string | null; ledger: number | null }>(
    "select cursor, ledger from indexer_state where key = 'escrow'",
  );
  const state = rows[0];
  const from = state?.cursor
    ? { cursor: state.cursor }
    : { startLedger: Math.max(1, (await events.latestLedger()) - 1000) };
  let page: Awaited<ReturnType<EscrowClient["events"]>>;
  try {
    page = await events.events(from);
  } catch (e) {
    // The cursor may have fallen out of the RPC retention window; restart near
    // the tip. Periodic reconciliation covers anything skipped.
    log.warn({ err: String(e) }, "event fetch failed; resetting cursor");
    await db.query("delete from indexer_state where key = 'escrow'");
    return 0;
  }
  const touched = new Set<string>();
  for (const e of page.events) {
    await db.query(
      `insert into chain_events (id, ledger, tx_hash, name, onchain_task_id, data)
       values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing`,
      [e.id, e.ledger, e.txHash, e.name, e.taskId, JSON.stringify(e.data)],
    );
    if (e.taskId) touched.add(e.taskId);
  }
  await db.query(
    `insert into indexer_state (key, cursor, ledger, updated_at) values ('escrow', $1, $2, now())
     on conflict (key) do update set cursor = excluded.cursor, ledger = excluded.ledger, updated_at = now()`,
    [page.cursor, page.latestLedger],
  );
  for (const onchainId of touched) {
    const { rows: tasks } = await db.query<{ id: string }>(
      "select id from tasks where onchain_id = $1",
      [onchainId],
    );
    for (const t of tasks) await syncTask(db, chain, t.id).catch(() => {});
  }
  return page.events.length;
}

export function startWorker(deps: WorkerDeps, intervalMs = 4000) {
  let stopped = false;
  let tick = 0;
  const loop = async () => {
    while (!stopped) {
      try {
        await pollSubmittedOps(deps);
        await expirePreparedOps(deps);
        if (tick % 3 === 0) await indexEvents(deps);
        if (tick % 5 === 0) await reconcileTasks(deps);
      } catch (e) {
        deps.log.error({ err: String(e) }, "worker iteration failed");
      }
      tick++;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  const finished = loop();
  // Resolves once the in-flight iteration (if any) has completed.
  return async () => {
    stopped = true;
    await finished;
  };
}
