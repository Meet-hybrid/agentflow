// Tries everything the sandbox must forbid and reports what happened.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const r: Record<string, unknown> = {};
const attempt = (name: string, fn: () => unknown) => {
  try {
    fn();
    r[name] = "ALLOWED";
  } catch (e) {
    r[name] = (e as { code?: string }).code ?? String(e);
  }
};
attempt("write", () => writeFileSync(`${tmpdir()}/agentflow-probe`, "x"));
attempt("readOutside", () => readFileSync("/etc/hostname"));
attempt("spawn", () => execSync("true"));
r.envKeys = Object.keys(process.env).length;
process.stdout.write(JSON.stringify({ ok: true, result: r }));
