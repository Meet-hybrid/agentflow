import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  StrKey,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  bytes32,
  contractErrorFrom,
  createChallenge,
  decodeTask,
  encodeArgs,
  fromBaseUnits,
  toBaseUnits,
  verifyChallenge,
  verifySigned,
} from "../src/index.ts";

const PASS = Networks.TESTNET;
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const TASK = "ab".repeat(32);

function buildTx(source: Keypair, fn = "approve") {
  return new TransactionBuilder(new Account(source.publicKey(), "41"), {
    fee: BASE_FEE,
    networkPassphrase: PASS,
  })
    .addOperation(new Contract(CONTRACT).call(fn, bytes32(TASK)))
    .setTimeout(300)
    .build();
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("amounts", () => {
  it("round-trips 7-decimal amounts exactly", () => {
    expect(toBaseUnits("10")).toBe(100_000_000n);
    expect(toBaseUnits("0.0000001")).toBe(1n);
    expect(toBaseUnits("12.5")).toBe(125_000_000n);
    expect(fromBaseUnits(125_000_000n)).toBe("12.5");
    expect(fromBaseUnits(1n)).toBe("0.0000001");
    expect(fromBaseUnits(100_000_000n)).toBe("10");
  });

  it("rejects malformed amounts", () => {
    for (const bad of ["", "-1", "1.00000001", "1e3", "abc"]) {
      expect(() => toBaseUnits(bad), bad).toThrow();
    }
  });
});

describe("encodeArgs", () => {
  it("encodes fund arguments in contract order with exact types", () => {
    const client = Keypair.random().publicKey();
    const args = encodeArgs({
      fn: "fund",
      taskId: TASK,
      client,
      token: CONTRACT,
      amount: 123_456_789n,
      deadline: 1_800_000_000,
    });
    expect(args.map((a) => a.type)).toEqual([
      "scvBytes",
      "scvAddress",
      "scvAddress",
      "scvI128",
      "scvU64",
    ]);
    expect(hex(scValToNative(args[0] as xdr.ScVal) as Uint8Array)).toBe(TASK);
    expect(scValToNative(args[1] as xdr.ScVal)).toBe(client);
    expect(scValToNative(args[3] as xdr.ScVal)).toBe(123_456_789n);
  });

  it("encodes resolve bps as u32 and rejects malformed ids", () => {
    const [, bps] = encodeArgs({ fn: "resolve", taskId: TASK, payeeBps: 2500 });
    expect(bps?.type).toBe("scvU32");
    expect(() => encodeArgs({ fn: "approve", taskId: "AB".repeat(32) })).toThrow();
    expect(() => encodeArgs({ fn: "approve", taskId: "ab" })).toThrow();
  });
});

describe("decodeTask", () => {
  it("decodes the contract's Task struct", () => {
    const payee = Keypair.random().publicKey();
    const raw = nativeToScVal({
      amount: nativeToScVal(5_000_000n, { type: "i128" }),
      arbiter: new Address(payee).toScVal(),
      client: new Address(payee).toScVal(),
      deadline: nativeToScVal(1_800_000_000n, { type: "u64" }),
      evidence: xdr.ScVal.scvVoid(),
      payee: new Address(payee).toScVal(),
      rejected_at: nativeToScVal(0n, { type: "u64" }),
      rejections: nativeToScVal(1, { type: "u32" }),
      review_window: nativeToScVal(3600n, { type: "u64" }),
      state: nativeToScVal(2, { type: "u32" }),
      submitted_at: nativeToScVal(1_700_000_000n, { type: "u64" }),
      token: new Address(CONTRACT).toScVal(),
    });
    expect(decodeTask(raw)).toEqual({
      state: "Submitted",
      payee,
      rejections: 1,
      submittedAt: 1_700_000_000,
      deadline: 1_800_000_000,
      reviewWindow: 3600,
      amount: 5_000_000n,
    });
  });
});

describe("contractErrorFrom", () => {
  it("maps contract error codes from simulation messages", () => {
    expect(contractErrorFrom("HostError: Error(Contract, #6)\n...")).toBe("InvalidState");
    expect(contractErrorFrom("HostError: Error(Contract, #99)")).toBe("Contract#99");
    expect(contractErrorFrom("HostError: Error(Auth, InvalidAction)")).toBeNull();
  });
});

describe("verifySigned", () => {
  const signer = Keypair.random();
  const tx = buildTx(signer);
  const hash = hex(tx.hash());

  it("accepts the prepared transaction signed by the expected account", () => {
    tx.sign(signer);
    const ok = verifySigned(tx.toXdr(), { hash, signer: signer.publicKey() }, PASS);
    expect(hex(ok.hash())).toBe(hash);
  });

  it("rejects a different transaction even if properly signed", () => {
    const other = buildTx(signer, "refund");
    other.sign(signer);
    expect(() => verifySigned(other.toXdr(), { hash, signer: signer.publicKey() }, PASS)).toThrow(
      /does not match/,
    );
  });

  it("rejects a signature from the wrong account", () => {
    const wrong = buildTx(signer);
    wrong.sign(Keypair.random());
    expect(() => verifySigned(wrong.toXdr(), { hash, signer: signer.publicKey() }, PASS)).toThrow(
      /not signed/,
    );
  });

  it("rejects an unsigned transaction and garbage input", () => {
    const unsigned = buildTx(signer);
    expect(() =>
      verifySigned(unsigned.toXdr(), { hash, signer: signer.publicKey() }, PASS),
    ).toThrow(/not signed/);
    expect(() => verifySigned("not-xdr", { hash, signer: signer.publicKey() }, PASS)).toThrow(
      /invalid transaction/,
    );
  });

  it("rejects a transaction for another network", () => {
    tx.sign(signer);
    expect(() =>
      verifySigned(tx.toXdr(), { hash, signer: signer.publicKey() }, Networks.PUBLIC),
    ).toThrow();
  });
});

describe("SEP-10", () => {
  const server = Keypair.random();
  const config = {
    serverSecret: server.secret(),
    homeDomain: "agentflow.local",
    webAuthDomain: "agentflow.local",
    networkPassphrase: PASS,
  };

  it("authenticates the account that signed the challenge", () => {
    const user = Keypair.random();
    const challenge = TransactionBuilder.fromXDR(createChallenge(config, user.publicKey()), PASS);
    challenge.sign(user);
    expect(verifyChallenge(config, challenge.toXdr())).toBe(user.publicKey());
  });

  it("rejects a challenge signed by someone else", () => {
    const user = Keypair.random();
    const challenge = TransactionBuilder.fromXDR(createChallenge(config, user.publicKey()), PASS);
    challenge.sign(Keypair.random());
    expect(() => verifyChallenge(config, challenge.toXdr())).toThrow();
  });

  it("rejects a challenge issued by another server", () => {
    const user = Keypair.random();
    const forged = createChallenge(
      { ...config, serverSecret: Keypair.random().secret() },
      user.publicKey(),
    );
    const tx = TransactionBuilder.fromXDR(forged, PASS);
    tx.sign(user);
    expect(() => verifyChallenge(config, tx.toXdr())).toThrow();
  });
});
