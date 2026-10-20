import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { stellarGateway } from "./gateway.ts";
import { startWorker } from "./worker.ts";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);
const chain = stellarGateway(config);
// Structured JSON lines, matching the API's log format.
const line = (level: string) => (obj: unknown, msg?: string) =>
  console.log(
    JSON.stringify({
      level,
      time: Date.now(),
      msg,
      ...(typeof obj === "object" ? obj : { msg: obj }),
    }),
  );
const log = { info: line("info"), warn: line("warn"), error: line("error") };
const stop = startWorker({ db, chain, events: chain.client, log });
log.info({}, "worker started");
process.on("SIGTERM", () => {
  stop();
  void db.end().then(() => process.exit(0));
});
