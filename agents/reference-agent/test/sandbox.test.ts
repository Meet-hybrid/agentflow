import { fileURLToPath } from "node:url";
import { runCsvAggregate } from "@agentflow/shared";
import { describe, expect, it } from "vitest";
import { csvAggregateExecutor } from "../src/executors/index.ts";
import { runSandboxed, SandboxError } from "../src/sandbox.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const spec = {
  type: "csv-aggregate" as const,
  version: 1 as const,
  csv: "team,points\nred,3\nblue,5\nred,4\n",
  groupBy: "team",
  metrics: [{ column: "points", op: "sum" as const }],
  decimals: 0,
};

describe("sandbox", () => {
  it("forbids file writes, reading outside the code, spawning, and sees no environment", async () => {
    process.env.SECRET_THAT_MUST_NOT_LEAK = "x";
    const r = (await runSandboxed(fixture("probe.ts"), {}, { timeoutMs: 10_000 })) as Record<string, unknown>;
    expect(r).toEqual({
      write: "ERR_ACCESS_DENIED",
      readOutside: "ERR_ACCESS_DENIED",
      spawn: "ERR_ACCESS_DENIED",
      envKeys: 0,
    });
  });

  it("kills executions that exceed their time limit", async () => {
    const started = Date.now();
    await expect(runSandboxed(fixture("spin.ts"), {}, { timeoutMs: 1500 })).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("csv-aggregate executor", () => {
  it("really executes the task in the sandbox", async () => {
    const result = await csvAggregateExecutor.execute(spec, { timeoutMs: 10_000 });
    expect(result.output).toEqual(runCsvAggregate(spec));
    expect(result.output).toEqual({ columns: ["team", "sum_points"], rows: [["blue", "5"], ["red", "7"]], inputRows: 3 });
    expect(result.evidence.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.executor).toBe("agentflow-reference/csv-aggregate@1");
  });

  it("reports invalid task input as a task error", async () => {
    await expect(
      csvAggregateExecutor.execute({ ...spec, csv: "team,points\nred,lots\n" }, { timeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(SandboxError);
    await expect(
      csvAggregateExecutor.execute({ ...spec, csv: "team,points\nred,lots\n" }, { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ kind: "task_error" });
  });

  it("evaluates specs against declared limits", () => {
    expect(csvAggregateExecutor.evaluate(spec, {}).accept).toBe(true);
    expect(csvAggregateExecutor.evaluate(spec, { maxRows: 2 }).accept).toBe(false);
    expect(csvAggregateExecutor.evaluate({ type: "shell", cmd: "rm -rf /" }, {}).accept).toBe(false);
  });
});
