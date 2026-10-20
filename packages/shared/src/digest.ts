/**
 * Canonical hashing shared by agents, the API and verifiers. Uses WebCrypto
 * so it runs unchanged in Node and the browser.
 */

/** JSON with object keys sorted recursively and no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const hashJson = (value: unknown) => sha256Hex(canonicalJson(value));

export interface SubmissionEvidence {
  executor: string;
  specSha256: string;
  outputSha256: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/**
 * The 32-byte value an agent records on-chain with `submit`. Binds the task,
 * the attempt number and the exact output, so the on-chain record proves which
 * result the client was asked to review.
 */
export function submissionDigest(input: {
  taskId: string;
  attempt: number;
  outputSha256: string;
  specSha256: string;
}): Promise<string> {
  return hashJson({
    v: 1,
    taskId: input.taskId,
    attempt: input.attempt,
    outputSha256: input.outputSha256,
    specSha256: input.specSha256,
  });
}
