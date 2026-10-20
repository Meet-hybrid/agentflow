import { describe, expect, it } from "vitest";
import { canonicalJson, hashJson, sha256Hex, submissionDigest } from "../src/index.ts";

describe("digest", () => {
  it("canonical JSON sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("sha256 matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hash is independent of key order", async () => {
    expect(await hashJson({ a: 1, b: 2 })).toBe(await hashJson({ b: 2, a: 1 }));
  });

  it("submission digest changes with any bound field", async () => {
    const base = { taskId: "t", attempt: 1, outputSha256: "a".repeat(64), specSha256: "b".repeat(64) };
    const d = await submissionDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(await submissionDigest({ ...base, attempt: 2 })).not.toBe(d);
    expect(await submissionDigest({ ...base, taskId: "u" })).not.toBe(d);
    expect(await submissionDigest({ ...base, outputSha256: "c".repeat(64) })).not.toBe(d);
  });
});
