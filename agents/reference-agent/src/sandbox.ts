/**
 * Runs an executor entry point in a separate, locked-down Node process:
 *  - Node permission model: read-only access to the code directory, no file
 *    writes, no child processes, no worker threads, no native addons;
 *  - an empty environment, so the agent's API key and signing key are not
 *    visible to it;
 *  - a heap limit and a wall-clock timeout (the process is killed);
 *  - input on stdin and output on stdout, capped in size.
 * Node 22's permission model does not restrict network access; executors
 * shipped here never open connections.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CODE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class SandboxError extends Error {
  override name = "SandboxError";
  readonly kind: "timeout" | "crashed" | "invalid_output" | "task_error";
  constructor(kind: SandboxError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface SandboxOptions {
  timeoutMs: number;
  maxHeapMb?: number;
}

export function runSandboxed(
  entry: string,
  input: unknown,
  opts: SandboxOptions,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${CODE_ROOT}`,
        `--max-old-space-size=${opts.maxHeapMb ?? 64}`,
        "--disable-warning=ExperimentalWarning",
        entry,
      ],
      { env: {}, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new SandboxError("timeout", `execution exceeded ${opts.timeoutMs} ms`)));
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new SandboxError("invalid_output", "output too large")));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => finish(() => reject(new SandboxError("crashed", e.message))));
    child.on("close", (code) =>
      finish(() => {
        let parsed: { ok: boolean; result?: unknown; error?: string };
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return reject(
            new SandboxError(
              "crashed",
              `executor exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
            ),
          );
        }
        if (!parsed.ok)
          return reject(new SandboxError("task_error", parsed.error ?? "task failed"));
        resolve(parsed.result);
      }),
    );
    child.stdin.end(JSON.stringify(input));
  });
}
