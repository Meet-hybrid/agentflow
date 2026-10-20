/**
 * Sandboxed entry point for csv-aggregate. Reads {spec} on stdin, writes
 * {ok, result} or {ok: false, error} on stdout. Runs with no environment,
 * read-only filesystem access and no ability to spawn processes.
 */
import { csvAggregateSpecSchema, runCsvAggregate } from "@agentflow/shared";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  input += c;
});
process.stdin.on("end", () => {
  try {
    const spec = csvAggregateSpecSchema.parse(JSON.parse(input).spec);
    process.stdout.write(JSON.stringify({ ok: true, result: runCsvAggregate(spec) }));
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  }
});
