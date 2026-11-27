/**
 * `js-function` executor: an AI model writes the function, the agent runs the
 * client's tests on it, and failures go back to the model for another try.
 * Only code that passes every test is submitted; the platform then runs the
 * same tests itself before the result can be recorded on-chain.
 *
 * The model is behind the `CodeWriter` interface, so the loop is tested
 * without network access and other providers can be plugged in.
 */
import { hashJson, type JsFunctionSpec, jsFunctionSpecSchema } from "@agentflow/shared";
import {
  type IsolatedOptions,
  runJsFunctionTestsIsolated,
} from "@agentflow/shared/js-function-runner";
import { SandboxError } from "../sandbox.ts";
import type { ExecutionResult, TaskExecutor } from "./index.ts";

/** One conversation with a model about one task. */
export interface CodeSession {
  /**
   * Returns the model's next version of the code. `feedback` describes how
   * the previous version failed; it is absent on the first call.
   */
  next(feedback: string | undefined, opts: { timeoutMs: number }): Promise<string>;
}

export interface CodeWriter {
  /** Identifies the model, e.g. "claude-opus-5-5"; recorded in the evidence. */
  readonly model: string;
  start(spec: JsFunctionSpec): CodeSession;
}

export interface JsFunctionExecutorOptions {
  writer: CodeWriter;
  /** Model rounds per execution attempt. */
  maxRounds?: number;
  /** Local test runner; replaceable in tests. */
  runTests?: typeof runJsFunctionTestsIsolated;
}

/** Tasks shorter than this leave the model too little time to work. */
export const MIN_JS_DURATION_SECONDS = 120;
const LOCAL_TEST_TIMEOUT_MS = 30_000;

export function jsFunctionExecutor(opts: JsFunctionExecutorOptions): TaskExecutor {
  const maxRounds = opts.maxRounds ?? 3;
  const runTests = opts.runTests ?? runJsFunctionTestsIsolated;
  const id = `agentflow-reference/js-function@1+${opts.writer.model}`;

  return {
    taskType: "js-function",
    id,
    description: `writes the function with ${opts.writer.model} and submits it only after it passes every test`,
    verifiedClaim: "passes every one of the client's tests when the platform runs them",

    evaluate(spec, limits) {
      const parsed = jsFunctionSpecSchema.safeParse(spec);
      if (!parsed.success) {
        return {
          accept: false,
          reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        };
      }
      const reasons: string[] = [];
      if (
        limits.maxDurationSeconds !== undefined &&
        limits.maxDurationSeconds < MIN_JS_DURATION_SECONDS
      ) {
        reasons.push(
          `maxDurationSeconds ${limits.maxDurationSeconds} is under the ${MIN_JS_DURATION_SECONDS} s this agent needs`,
        );
      }
      return { accept: reasons.length === 0, reasons };
    },

    async execute(spec, { timeoutMs }): Promise<ExecutionResult> {
      const parsed = jsFunctionSpecSchema.parse(spec);
      const started = new Date();
      const deadline = started.getTime() + timeoutMs;
      const session = opts.writer.start(parsed);
      let feedback: string | undefined;
      const tried: string[] = [];

      for (let round = 1; round <= maxRounds; round++) {
        const left = deadline - Date.now();
        if (left < 5_000) break;
        const code = await session.next(feedback, { timeoutMs: left });
        const testOpts: IsolatedOptions = {
          timeoutMs: Math.min(LOCAL_TEST_TIMEOUT_MS, Math.max(1_000, deadline - Date.now())),
        };
        const report = await runTests(parsed, code, testOpts);
        tried.push(`round ${round}: ${report.passed}/${report.total} tests passed`);
        if (report.matches) {
          const output = { language: "javascript" as const, code };
          const finished = new Date();
          return {
            output,
            evidence: {
              executor: id,
              specSha256: await hashJson(parsed),
              outputSha256: await hashJson(output),
              startedAt: started.toISOString(),
              finishedAt: finished.toISOString(),
              durationMs: finished.getTime() - started.getTime(),
            },
          };
        }
        feedback = describeFailures(parsed, report.failures, report.passed, report.total);
      }
      throw new SandboxError(
        "task_error",
        `no version of the code passed every test (${tried.join("; ") || "out of time"})`,
      );
    },

    summarize(output) {
      const code = (output as { code?: string }).code ?? "";
      return `wrote ${code.split("\n").length} lines of code that pass every test`;
    },
  };
}

/** Plain-language test failures for the model's next round. */
export function describeFailures(
  spec: JsFunctionSpec,
  failures: { test: number; error?: string; actual?: unknown; expected?: unknown }[],
  passed: number,
  total: number,
): string {
  const lines = [`${passed} of ${total} tests passed. Failing tests:`];
  for (const f of failures) {
    const args = JSON.stringify(spec.tests[f.test]?.args ?? []);
    const call = `${spec.functionName}(...${args.length > 300 ? `${args.slice(0, 300)}…` : args})`;
    if (f.error) {
      lines.push(`- test ${f.test}: ${call} failed: ${f.error}`);
    } else {
      lines.push(
        `- test ${f.test}: ${call} returned ${JSON.stringify(f.actual)}, expected ${JSON.stringify(f.expected)}`,
      );
    }
  }
  lines.push("Fix the function so that every test passes, without special-casing the test inputs.");
  return lines.join("\n");
}
