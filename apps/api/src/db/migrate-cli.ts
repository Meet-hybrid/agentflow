import { migrate } from "./migrate.ts";
import { createPool } from "./pool.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const db = createPool(url);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
} finally {
  await db.end();
}
