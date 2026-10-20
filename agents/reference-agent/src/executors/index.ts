/**
 * Executor adapter interface. An executor knows how to evaluate and perform
 * one task type; the runtime handles discovery, the API and signing. Other
 * agent frameworks integrate by implementing TaskExecutor (or by talking to
 * the REST API directly; see docs/agents/README.md).
 */
import { fileURLToPath } from "node:url";
import { type CsvAggregateSpec, csvAggregateSpecSchema, hashJson } from "@agentflow/shared";
import { runSandboxed } from "../sandbox.ts";

export interface Evaluation {
  accept: boolean;
  reasons: string[];
}

export interface ExecutionResult {
  output: unknown;
  evidence: {
    executor: string;
    specSha256: string;
    outputSha256: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
}

export interface TaskExecutor {
  readonly taskType: string;
  readonly id: string;
  evaluate(spec: unknown, limits: { maxRows?: number }): Evaluation;
  execute(spec: unknown, opts: { timeoutMs: number }): Promise<ExecutionResult>;
}

const ENTRY = fileURLToPath(new URL("./csv-aggregate-entry.ts", import.meta.url));

export const csvAggregateExecutor: TaskExecutor = {
  taskType: "csv-aggregate",
  id: "agentflow-reference/csv-aggregate@1",

  evaluate(spec, limits) {
    const parsed = csvAggregateSpecSchema.safeParse(spec);
    if (!parsed.success) {
      return {
        accept: false,
        reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      };
    }
    const rows = parsed.data.csv.split("\n").length - 1;
    const reasons: string[] = [];
    if (limits.maxRows !== undefined && rows > limits.maxRows) {
      reasons.push(`about ${rows} rows exceeds this agent's limit of ${limits.maxRows}`);
    }
    return { accept: reasons.length === 0, reasons };
  },

  async execute(spec, { timeoutMs }) {
    const parsed: CsvAggregateSpec = csvAggregateSpecSchema.parse(spec);
    const started = new Date();
    const output = await runSandboxed(ENTRY, { spec: parsed }, { timeoutMs });
    const finished = new Date();
    return {
      output,
      evidence: {
        executor: this.id,
        specSha256: await hashJson(parsed),
        outputSha256: await hashJson(output),
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
      },
    };
  },
};

export const EXECUTORS: Record<string, TaskExecutor> = {
  [csvAggregateExecutor.taskType]: csvAggregateExecutor,
};
