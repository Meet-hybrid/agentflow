/**
 * Runs a `js-function` submission against its task's tests.
 *
 * The code runs in QuickJS compiled to WebAssembly, not in Node: inside the
 * interpreter there is no `require`, `process`, file system, network or
 * timer, only the JavaScript language and its built-in objects. Each test
 * gets a fresh interpreter, so one test can't affect another, and each has a
 * memory cap, a stack cap and a deadline.
 *
 * Results leave the interpreter as a JSON string and are compared with the
 * expected value here, outside it, as canonical JSON. The submitted code can
 * only influence its own return values, never the comparison.
 *
 * The interpreter checks its deadline while running JavaScript, but not
 * inside long built-in calls (a huge `"x".repeat(n)` near the memory cap can
 * take seconds), and it runs synchronously. Services must therefore use
 * `runJsFunctionTestsIsolated`, which runs all of this in a locked-down child
 * process that is killed at a hard time limit.
 *
 * Node-only entry point (`@agentflow/shared/js-function-runner`), so the web
 * app doesn't bundle the WebAssembly module.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core";
import { canonicalJson } from "./digest.ts";
import type { JsFunctionSpec, JsTestReport } from "./js-function.ts";

export interface RunnerLimits {
  /** Wall-clock limit per test, including loading the code. */
  perTestMs: number;
  memoryBytes: number;
  stackBytes: number;
}

export const DEFAULT_LIMITS: RunnerLimits = {
  perTestMs: 1_000,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
};

const MAX_REPORTED_FAILURES = 10;
const MAX_RESULT_CHARS = 64 * 1024;

let quickjs: Promise<QuickJSWASMModule> | undefined;
const loadQuickJS = () => {
  // The library's documented loading form; it works with both the package's
  // ESM build and its CommonJS type declarations.
  quickjs ??= newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-wasmfile-release-sync"));
  return quickjs;
};

type TestOutcome = { ok: true; json: string } | { ok: false; error: string };

/** Runs one call of `functionName` with `args` in a fresh interpreter. */
async function runOne(
  code: string,
  functionName: string,
  args: unknown[],
  limits: RunnerLimits,
): Promise<TestOutcome> {
  const module = await loadQuickJS();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.perTestMs));
  const vm = runtime.newContext();
  try {
    // Load the submission on its own, so nothing in it (an unclosed comment,
    // a stray brace) can change the harness below.
    const loaded = vm.evalCode(code, "solution.js");
    if (loaded.error) {
      const error = describe(vm.dump(loaded.error));
      loaded.error.dispose();
      return { ok: false, error: `loading the code failed: ${error}` };
    }
    loaded.value.dispose();

    // Arguments are JSON, which is also a valid JavaScript expression.
    const harness = `(() => {
      if (typeof ${functionName} !== "function") {
        throw new TypeError("the code does not define a function named ${functionName}");
      }
      const result = ${functionName}(...${JSON.stringify(args)});
      if (result !== null && typeof result === "object" && typeof result.then === "function") {
        throw new TypeError("the function returned a Promise; it must return a value");
      }
      if (result === undefined) throw new TypeError("the function returned undefined");
      return JSON.stringify(result);
    })()`;
    const called = vm.evalCode(harness, "harness.js");
    if (called.error) {
      const error = describe(vm.dump(called.error));
      called.error.dispose();
      return { ok: false, error };
    }
    const json: unknown = vm.dump(called.value);
    called.value.dispose();
    if (typeof json !== "string")
      return { ok: false, error: "the result is not JSON-serialisable" };
    if (json.length > MAX_RESULT_CHARS) return { ok: false, error: "the result is too large" };
    return { ok: true, json };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

function describe(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { name?: unknown; message?: unknown };
    if (typeof e.message === "string") {
      const name = typeof e.name === "string" ? e.name : "Error";
      // QuickJS reports a deadline as "interrupted".
      if (e.message === "interrupted") return "time limit exceeded";
      return `${name}: ${e.message}`.slice(0, 500);
    }
  }
  return String(error).slice(0, 500);
}

/** Runs every test; `matches` is true only if all of them pass. */
export async function runJsFunctionTests(
  spec: JsFunctionSpec,
  code: string,
  limits: RunnerLimits = DEFAULT_LIMITS,
): Promise<JsTestReport> {
  const started = Date.now();
  const failures: JsTestReport["failures"] = [];
  let passed = 0;
  for (const [index, test] of spec.tests.entries()) {
    let outcome: TestOutcome;
    try {
      outcome = await runOne(code, spec.functionName, test.args, limits);
    } catch (e) {
      // The interpreter itself failed, for example it ran out of memory.
      outcome = { ok: false, error: describe(e) };
    }
    if (outcome.ok) {
      let actual: unknown;
      try {
        actual = JSON.parse(outcome.json);
      } catch {
        actual = undefined;
      }
      if (actual !== undefined && canonicalJson(actual) === canonicalJson(test.expected)) {
        passed++;
        continue;
      }
      if (failures.length < MAX_REPORTED_FAILURES) {
        failures.push({ test: index, actual, expected: test.expected });
      }
    } else if (failures.length < MAX_REPORTED_FAILURES) {
      failures.push({ test: index, error: outcome.error, expected: test.expected });
    }
  }
  return {
    method: "test-suite",
    matches: passed === spec.tests.length,
    passed,
    total: spec.tests.length,
    failures,
    durationMs: Date.now() - started,
  };
}

// ----- Isolated runner --------------------------------------------------------

const WORKER = fileURLToPath(new URL("./js-function-worker.ts", import.meta.url));
/** The repository root: the child may read code and node_modules, nothing else. */
const CODE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_WORKER_OUTPUT = 1024 * 1024;

export interface IsolatedOptions {
  /** Hard wall-clock limit for the whole run; the process is killed after it. */
  timeoutMs: number;
  limits?: RunnerLimits;
}

/**
 * Runs `runJsFunctionTests` in a separate Node process: an empty environment
 * (no API keys, database URL or signing keys), Node's permission model
 * (read-only access to the code, no file writes, child processes, workers or
 * native addons), a 64 MB JavaScript heap, and SIGKILL at `timeoutMs`. If the
 * process is killed or crashes, the report counts every test as failed.
 */
export function runJsFunctionTestsIsolated(
  spec: JsFunctionSpec,
  code: string,
  opts: IsolatedOptions,
): Promise<JsTestReport> {
  const started = Date.now();
  const failed = (error: string): JsTestReport => ({
    method: "test-suite",
    matches: false,
    passed: 0,
    total: spec.tests.length,
    failures: [{ test: 0, error }],
    durationMs: Date.now() - started,
  });

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${CODE_ROOT}`,
        "--max-old-space-size=64",
        "--disable-warning=ExperimentalWarning",
        WORKER,
      ],
      { env: {}, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (report: JsTestReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(report);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(failed(`time limit exceeded: the tests did not finish within ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_WORKER_OUTPUT) {
        child.kill("SIGKILL");
        finish(failed("test output too large"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => finish(failed(`could not start the test runner: ${e.message}`)));
    child.on("close", (exitCode) => {
      try {
        const parsed = JSON.parse(stdout) as
          | { ok: true; report: JsTestReport }
          | { ok: false; error: string };
        if (parsed.ok) finish({ ...parsed.report, durationMs: Date.now() - started });
        else finish(failed(parsed.error));
      } catch {
        finish(failed(`test runner exited with code ${exitCode}: ${stderr.trim().slice(0, 300)}`));
      }
    });
    child.stdin.end(JSON.stringify({ spec, code, limits: opts.limits ?? DEFAULT_LIMITS }));
  });
}
