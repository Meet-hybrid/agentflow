/**
 * Executor adapter interface. An executor knows how to evaluate and perform
 * one task type; the runtime handles discovery, the API and signing. Other
 * agent frameworks integrate by implementing TaskExecutor (or by talking to
 * the REST API directly; see docs/agents/README.md).
 */
import { fileURLToPath } from "node:url";
import { type CsvAggregateSpec, csvAggregateSpecSchema, hashJson } from "@agentflow/shared";
import { runSandboxed } from "../sandbox.ts";
import { type CodeWriter, jsFunctionExecutor } from "./js-function.ts";

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

export interface EvaluationLimits {
  /** From the agent's registered capability (csv-aggregate). */
  maxRows?: number;
  /** The task's time limit. */
  maxDurationSeconds?: number;
}

export interface TaskExecutor {
  readonly taskType: string;
  readonly id: string;
  /** How the executor works, for the application message. */
  readonly description: string;
  /** What the platform's verification shows when it matches, for disputes. */
  readonly verifiedClaim: string;
  evaluate(spec: unknown, limits: EvaluationLimits): Evaluation;
  execute(spec: unknown, opts: { timeoutMs: number }): Promise<ExecutionResult>;
  /** One line about a result, for the task's run log. */
  summarize(output: unknown): string;
}

const ENTRY = fileURLToPath(new URL("./csv-aggregate-entry.ts", import.meta.url));

export const csvAggregateExecutor: TaskExecutor = {
  taskType: "csv-aggregate",
  id: "agentflow-reference/csv-aggregate@1",
  description: "deterministic csv-aggregate executor running in a sandbox",
  verifiedClaim: "matches the platform's deterministic recomputation",

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

  summarize(output) {
    const rows = (output as { rows?: unknown[] })?.rows;
    return `computed ${Array.isArray(rows) ? rows.length : 0} output rows`;
  },
};

/**
 * The executors an agent runs. With a `writer` (an AI model) the agent can
 * also take js-function tasks.
 */
export function createExecutors(opts: { writer?: CodeWriter } = {}): Record<string, TaskExecutor> {
  const executors: Record<string, TaskExecutor> = {
    [csvAggregateExecutor.taskType]: csvAggregateExecutor,
  };
  if (opts.writer) {
    const js = jsFunctionExecutor({ writer: opts.writer });
    executors[js.taskType] = js;
  }
  return executors;
}
