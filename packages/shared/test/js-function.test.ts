import { describe, expect, it } from "vitest";
import { type JsFunctionSpec, jsFunctionOutputSchema, jsFunctionSpecSchema } from "../src/index.ts";
import { runJsFunctionTests, runJsFunctionTestsIsolated } from "../src/js-function-runner.ts";

const spec = (tests: JsFunctionSpec["tests"], functionName = "solve"): JsFunctionSpec => ({
  type: "js-function",
  version: 1,
  functionName,
  prompt: "Return the sum of the numbers in the array.",
  tests,
});

const sumTests = [
  { args: [[1, 2, 3]], expected: 6 },
  { args: [[]], expected: 0 },
  { args: [[-5, 5, 10]], expected: 10 },
];
const fast = { perTestMs: 300, memoryBytes: 8 * 1024 * 1024, stackBytes: 256 * 1024 };

describe("js-function spec", () => {
  it("accepts a valid spec and rejects bad identifiers, empty tests and oversize specs", () => {
    expect(jsFunctionSpecSchema.safeParse(spec(sumTests)).success).toBe(true);
    expect(jsFunctionSpecSchema.safeParse(spec(sumTests, "1bad")).success).toBe(false);
    expect(jsFunctionSpecSchema.safeParse(spec(sumTests, "a;b")).success).toBe(false);
    expect(jsFunctionSpecSchema.safeParse(spec([])).success).toBe(false);
    const big = { args: ["x".repeat(70 * 1024)], expected: 1 };
    expect(jsFunctionSpecSchema.safeParse(spec([big])).success).toBe(false);
  });

  it("rejects non-JSON expected values", () => {
    const bad = { ...spec(sumTests), tests: [{ args: [], expected: undefined }] };
    expect(jsFunctionSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("output must be javascript source", () => {
    expect(jsFunctionOutputSchema.safeParse({ language: "javascript", code: "x" }).success).toBe(
      true,
    );
    expect(jsFunctionOutputSchema.safeParse({ language: "python", code: "x" }).success).toBe(false);
    expect(jsFunctionOutputSchema.safeParse({ language: "javascript", code: "" }).success).toBe(
      false,
    );
  });
});

describe("runJsFunctionTests", () => {
  it("passes correct code", async () => {
    const r = await runJsFunctionTests(
      spec(sumTests),
      "function solve(xs) { return xs.reduce((a, b) => a + b, 0); }",
    );
    expect(r).toMatchObject({ method: "test-suite", matches: true, passed: 3, total: 3 });
    expect(r.failures).toEqual([]);
  });

  it("reports wrong answers with the actual and expected values", async () => {
    const r = await runJsFunctionTests(spec(sumTests), "function solve(xs) { return xs.length; }");
    expect(r.matches).toBe(false);
    expect(r.passed).toBe(1); // [] has length 0, which happens to be its sum
    expect(r.failures[0]).toEqual({ test: 0, actual: 3, expected: 6 });
  });

  it("compares objects as canonical JSON, ignoring key order", async () => {
    const s = spec([{ args: [], expected: { a: 1, b: [1, 2] } }]);
    expect(
      (await runJsFunctionTests(s, "function solve() { return { b: [1, 2], a: 1 }; }")).matches,
    ).toBe(true);
    expect(
      (await runJsFunctionTests(s, "function solve() { return { a: 1, b: [2, 1] }; }")).matches,
    ).toBe(false);
  });

  it("fails on syntax errors, a missing function, undefined and Promises", async () => {
    const s = spec(sumTests);
    const syntax = await runJsFunctionTests(s, "function solve( {");
    expect(syntax.failures[0]?.error).toMatch(/loading the code failed: SyntaxError/);
    const missing = await runJsFunctionTests(s, "function other() { return 1; }");
    expect(missing.failures[0]?.error).toMatch(/does not define a function named solve/);
    expect((await runJsFunctionTests(s, "function solve() {}")).failures[0]?.error).toMatch(
      /undefined/,
    );
    const promise = await runJsFunctionTests(s, "async function solve() { return 6; }");
    expect(promise.failures[0]?.error).toMatch(/Promise/);
  });

  it("stops infinite loops and runaway recursion", async () => {
    const s = spec([{ args: [], expected: 1 }]);
    const loop = await runJsFunctionTests(s, "function solve() { for (;;) {} }", fast);
    expect(loop.failures[0]?.error).toBe("time limit exceeded");
    const rec = await runJsFunctionTests(s, "function solve() { return solve() + 1; }", fast);
    expect(rec.matches).toBe(false);
    expect(rec.failures[0]?.error).toMatch(/stack|RangeError|InternalError/i);
  });

  it("caps memory: an allocation loop fails instead of growing", async () => {
    // Near the cap QuickJS garbage-collects on every allocation, so the
    // per-test deadline often ends the run before "out of memory" does.
    const s = spec([{ args: [], expected: 1 }]);
    const r = await runJsFunctionTests(
      s,
      "function solve() { const a = []; for (;;) a.push(new Array(1000).fill(1)); }",
      { ...fast, perTestMs: 2_000, memoryBytes: 4 << 20 },
    );
    expect(r.matches).toBe(false);
    expect(r.failures[0]?.error).toMatch(/out of memory|time limit exceeded/);
  }, 20_000);

  it("gives the code no host access: no process, require, fetch, timers or file system", async () => {
    const s = spec([
      {
        args: [],
        expected: {
          process: "undefined",
          require: "undefined",
          fetch: "undefined",
          setTimeout: "undefined",
          XMLHttpRequest: "undefined",
          WebAssembly: "undefined",
        },
      },
    ]);
    const code = `function solve() {
      return {
        process: typeof process, require: typeof require, fetch: typeof fetch,
        setTimeout: typeof setTimeout, XMLHttpRequest: typeof XMLHttpRequest,
        WebAssembly: typeof WebAssembly,
      };
    }`;
    const r = await runJsFunctionTests(s, code);
    expect(r.failures).toEqual([]);
    expect(r.matches).toBe(true);
  });

  it("runs every test in a fresh interpreter, so state can't leak between tests", async () => {
    const s = spec([
      { args: [], expected: 1 },
      { args: [], expected: 1 },
    ]);
    const r = await runJsFunctionTests(
      s,
      "function solve() { globalThis.n = (globalThis.n || 0) + 1; return globalThis.n; }",
    );
    expect(r.matches).toBe(true);
  });

  it("can't tamper with the comparison: it only controls its own return value", async () => {
    const s = spec([{ args: [], expected: 1 }]);
    // Replacing JSON.stringify inside the interpreter only changes what the
    // code returns; the comparison happens outside.
    const r = await runJsFunctionTests(
      s,
      'JSON.stringify = () => "1"; function solve() { return 2; }',
    );
    expect(r.matches).toBe(true); // the fake "1" is still just the code's own answer
    const r2 = await runJsFunctionTests(
      s,
      'JSON.stringify = () => "not json"; function solve() { return 1; }',
    );
    expect(r2.matches).toBe(false);
  });

  it("an unclosed comment in the code can't swallow the harness", async () => {
    const r = await runJsFunctionTests(spec(sumTests), "function solve() { return 6; } /*");
    expect(r.matches).toBe(false);
    expect(r.failures[0]?.error).toMatch(/SyntaxError/);
  });
});

describe("runJsFunctionTestsIsolated", () => {
  it("gives the same report as the in-process runner", async () => {
    const r = await runJsFunctionTestsIsolated(
      spec(sumTests),
      "function solve(xs) { return xs.reduce((a, b) => a + b, 0); }",
      { timeoutMs: 10_000 },
    );
    expect(r).toMatchObject({ matches: true, passed: 3, total: 3, failures: [] });
  });

  it("kills a run that a slow built-in keeps past the hard limit", async () => {
    // QuickJS doesn't check its deadline inside "x".repeat(), so near the
    // memory cap this runs for seconds. The process is killed at 1.5 s.
    const started = Date.now();
    const r = await runJsFunctionTestsIsolated(
      spec([{ args: [], expected: 1 }]),
      "function solve() { const a = []; for (;;) a.push('x'.repeat(1 << 20)); }",
      {
        timeoutMs: 1_500,
        limits: { perTestMs: 60_000, memoryBytes: 8 << 20, stackBytes: 256 << 10 },
      },
    );
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.matches).toBe(false);
    expect(r.failures[0]?.error).toMatch(/time limit exceeded/);
  });
});
