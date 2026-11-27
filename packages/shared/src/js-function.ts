/**
 * `js-function`: write a JavaScript function that passes the client's tests.
 *
 * The client describes a function in words and supplies test cases (arguments
 * and the expected return value, both as JSON). The agent returns the source
 * of the function. Anyone can check a submission by running the tests:
 * `runJsFunctionTests` in `js-function-runner.ts` does that inside a
 * WebAssembly JavaScript interpreter with no I/O.
 *
 * This is the first task type meant for AI agents: writing the function takes
 * judgement, but checking it doesn't.
 *
 * Limitations: the tests are public, so code that special-cases the test
 * inputs also passes; the client's review is the check against that. Plain
 * synchronous JavaScript only (no imports, no I/O, no Promises). Values are
 * compared as JSON, so `undefined`, functions, `NaN` and `-0` can't be
 * expected results.
 *
 * This module only holds schemas, so the web app can import it.
 */
import { z } from "zod";
import { canonicalJson } from "./digest.ts";

export const JS_FUNCTION = "js-function" as const;
export const MAX_JS_SPEC_BYTES = 64 * 1024;
export const MAX_JS_CODE_BYTES = 64 * 1024;
export const MAX_JS_TESTS = 50;
export const MAX_JS_ARGS = 10;

const byteLength = (s: string) => new TextEncoder().encode(s).length;

export const jsTestCaseSchema = z.object({
  args: z.array(z.json()).max(MAX_JS_ARGS),
  expected: z.json(),
});
export type JsTestCase = z.infer<typeof jsTestCaseSchema>;

export const jsFunctionSpecSchema = z
  .object({
    type: z.literal(JS_FUNCTION),
    version: z.literal(1),
    functionName: z
      .string()
      .regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/, "must be a JavaScript identifier"),
    /** What the function should do, in the client's words. */
    prompt: z.string().trim().min(1).max(8000),
    tests: z.array(jsTestCaseSchema).min(1).max(MAX_JS_TESTS),
  })
  .refine((spec) => byteLength(canonicalJson(spec)) <= MAX_JS_SPEC_BYTES, {
    message: `specification must be at most ${MAX_JS_SPEC_BYTES / 1024} KiB`,
  });
export type JsFunctionSpec = z.infer<typeof jsFunctionSpecSchema>;

export const jsFunctionOutputSchema = z.object({
  language: z.literal("javascript"),
  code: z
    .string()
    .min(1)
    .refine((s) => byteLength(s) <= MAX_JS_CODE_BYTES, {
      message: `code must be at most ${MAX_JS_CODE_BYTES / 1024} KiB`,
    }),
});
export type JsFunctionOutput = z.infer<typeof jsFunctionOutputSchema>;

/** Result of running a submission against a task's tests. */
export interface JsTestReport {
  method: "test-suite";
  /** True only if every test passed. */
  matches: boolean;
  passed: number;
  total: number;
  /** The first few failures, for the agent and the client's review. */
  failures: { test: number; error?: string; actual?: unknown; expected?: unknown }[];
  durationMs: number;
}
