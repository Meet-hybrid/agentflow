import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Db } from "./pool.ts";

const DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Applies pending migrations in filename order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  try {
    // Serialize concurrent migrators (e.g. API and worker starting together).
    await client.query("select pg_advisory_lock(4711)");
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const applied: string[] = [];
    for (const name of (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      const sql = await readFile(DIR + name, "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
        applied.push(name);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration ${name} failed: ${String(e)}`);
      }
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock(4711)").catch(() => {});
    client.release();
  }
}
