import type { JsFunctionSpec } from "@agentflow/shared";
import { describe, expect, it } from "vitest";
import {
  type CodeWriter,
  describeFailures,
  jsFunctionExecutor,
} from "../src/executors/js-function.ts";
import { SandboxError } from "../src/sandbox.ts";

const spec: JsFunctionSpec = {
  type: "js-function",
  version: 1,
  functionName: "median",
  prompt: "Return the median of an array of numbers; the mean of the middle two for even lengths.",
  tests: [
    { args: [[3, 1, 2]], expected: 2 },
    { args: [[4, 1, 3, 2]], expected: 2.5 },
    { args: [[7]], expected: 7 },
  ],
};

const WRONG = "function median(xs) { return xs[Math.floor(xs.length / 2)]; }";
const RIGHT = `function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}`;

/** A fake model that returns scripted answers and records the feedback. */
function scripted(answers: string[]) {
  const feedback: (string | undefined)[] = [];
  const writer: CodeWriter = {
    model: "fake-model",
    start() {
      let i = 0;
      return {
        async next(fb) {
          feedback.push(fb);
          const code = answers[Math.min(i++, answers.length - 1)];
          if (code === undefined) throw new Error("no answer scripted");
          return code;
        },
      };
    },
  };
  return { writer, feedback };
}

describe("js-function executor", () => {
  it("submits code that passes on the first round, with evidence naming the model", async () => {
    const { writer, feedback } = scripted([RIGHT]);
    const r = await jsFunctionExecutor({ writer }).execute(spec, { timeoutMs: 60_000 });
    expect(r.output).toEqual({ language: "javascript", code: RIGHT });
    expect(r.evidence.executor).toBe("agentflow-reference/js-function@1+fake-model");
    expect(r.evidence.specSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(feedback).toEqual([undefined]);
  });

  it("sends test failures back to the model and submits the fixed version", async () => {
    const { writer, feedback } = scripted([WRONG, RIGHT]);
    const r = await jsFunctionExecutor({ writer }).execute(spec, { timeoutMs: 60_000 });
    expect((r.output as { code: string }).code).toBe(RIGHT);
    expect(feedback).toHaveLength(2);
    expect(feedback[1]).toContain("1 of 3 tests passed");
    expect(feedback[1]).toContain("median(...[[3,1,2]]) returned 1, expected 2");
    expect(feedback[1]).toContain("without special-casing the test inputs");
  });

  it("never submits failing code: gives up after the last round with a task error", async () => {
    const { writer, feedback } = scripted([WRONG]);
    const exec = jsFunctionExecutor({ writer, maxRounds: 3 });
    const err = await exec.execute(spec, { timeoutMs: 60_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.kind).toBe("task_error");
    expect(err.message).toMatch(/round 3: 1\/3 tests passed/);
    expect(feedback).toHaveLength(3);
  });

  it("runs the model's code isolated: hostile code just fails its tests", async () => {
    const { writer } = scripted(["function median() { for (;;) {} }"]);
    const exec = jsFunctionExecutor({ writer, maxRounds: 1 });
    const err = await exec.execute(spec, { timeoutMs: 60_000 }).catch((e) => e);
    expect(err.kind).toBe("task_error");
    expect(err.message).toMatch(/0\/3 tests passed/);
  });

  it("declines invalid specs and tasks with too little time for a model", () => {
    const { writer } = scripted([RIGHT]);
    const exec = jsFunctionExecutor({ writer });
    expect(exec.evaluate(spec, { maxDurationSeconds: 300 })).toEqual({ accept: true, reasons: [] });
    expect(exec.evaluate(spec, { maxDurationSeconds: 60 }).accept).toBe(false);
    expect(exec.evaluate({ ...spec, functionName: "not valid" }, {}).accept).toBe(false);
  });

  it("describes errors as well as wrong values", () => {
    const text = describeFailures(spec, [{ test: 2, error: "time limit exceeded" }], 2, 3);
    expect(text).toContain("test 2: median(...[[7]]) failed: time limit exceeded");
  });
});
