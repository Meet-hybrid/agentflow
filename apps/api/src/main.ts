import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { stellarGateway } from "./gateway.ts";
import { startWorker } from "./worker.ts";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);
const chain = stellarGateway(config);
const app = buildApp({ config, db, chain });

// The worker runs in-process by default; set RUN_WORKER=0 to run it separately.
const stopWorker =
  process.env.RUN_WORKER === "0"
    ? () => {}
    : startWorker({ db, chain, events: chain.client, log: app.log });

const shutdown = async () => {
  stopWorker();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
