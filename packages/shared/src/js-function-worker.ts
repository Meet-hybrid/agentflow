/**
 * Child-process entry for `runJsFunctionTestsIsolated`. Reads
 * {spec, code, limits} on stdin and writes the test report on stdout.
 * Started with an empty environment, Node's permission model and a hard
 * timeout; see js-function-runner.ts.
 */
import { jsFunctionSpecSchema } from "./js-function.ts";
import { runJsFunctionTests } from "./js-function-runner.ts";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  input += c;
});
process.stdin.on("end", async () => {
  try {
    const { spec, code, limits } = JSON.parse(input);
    const report = await runJsFunctionTests(jsFunctionSpecSchema.parse(spec), String(code), limits);
    process.stdout.write(JSON.stringify({ ok: true, report }));
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  }
});
