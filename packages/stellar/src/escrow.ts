/**
 * Thin, typed access to the AgentFlow escrow contract over Stellar RPC.
 *
 * The API never signs escrow transactions. It prepares them (simulation sets
 * the footprint and resource fee), hands the XDR to the party that must sign,
 * checks that what comes back is byte-for-byte the transaction it prepared,
 * submits it and tracks the outcome.
 */

import type { ChainFn, OnchainState, OnchainTask } from "@agentflow/shared";
import { ONCHAIN_STATES } from "@agentflow/shared";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

/** Read-only simulations need a source account but never touch it. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
/** How long a prepared transaction stays valid. */
export const TX_TIMEOUT_SECONDS = 300;

export interface EscrowConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
}

/** Contract error codes (contracts/escrow `Error`). */
export const ESCROW_ERRORS: Record<number, string> = {
  1: "TaskExists",
  2: "TaskNotFound",
  3: "InvalidAmount",
  4: "TokenNotAllowed",
  5: "InvalidDeadline",
  6: "InvalidState",
  7: "DeadlinePassed",
  8: "DeadlineNotPassed",
  9: "ReviewWindowOpen",
  10: "InvalidBps",
  11: "NotParty",
  12: "InvalidPayee",
  13: "InvalidConfig",
  14: "ReviewWindowClosed",
};

export class EscrowError extends Error {
  override name = "EscrowError";
  readonly contractError: string | null;
  constructor(message: string, contractError: string | null) {
    super(message);
    this.contractError = contractError;
  }
}

/** Extracts `Error(Contract, #N)` from an RPC simulation error string. */
export function contractErrorFrom(message: string): string | null {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  return m ? (ESCROW_ERRORS[Number(m[1])] ?? `Contract#${m[1]}`) : null;
}

const hexToBytes = (hex: string) => Buffer.from(hex, "hex");

export function bytes32(hex: string): xdr.ScVal {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("expected 32 bytes of lowercase hex");
  return nativeToScVal(hexToBytes(hex), { type: "bytes" });
}

const addr = (a: string) => new Address(a).toScVal();
const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: "u64" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

/** Arguments for each contract call, in contract parameter order. */
export type EscrowCall =
  | { fn: "fund"; taskId: string; client: string; token: string; amount: bigint; deadline: number }
  | { fn: "assign"; taskId: string; payee: string }
  | { fn: "submit"; taskId: string; evidence: string }
  | { fn: "reject" | "approve" | "claim" | "abandon" | "refund"; taskId: string }
  | { fn: "dispute"; taskId: string; by: string }
  | { fn: "resolve"; taskId: string; payeeBps: number };

export function encodeArgs(call: EscrowCall): xdr.ScVal[] {
  const id = bytes32(call.taskId);
  switch (call.fn) {
    case "fund":
      return [id, addr(call.client), addr(call.token), i128(call.amount), u64(call.deadline)];
    case "assign":
      return [id, addr(call.payee)];
    case "submit":
      return [id, bytes32(call.evidence)];
    case "dispute":
      return [id, addr(call.by)];
    case "resolve":
      return [id, u32(call.payeeBps)];
    default:
      return [id];
  }
}

export interface PreparedTx {
  xdr: string;
  hash: string;
  source: string;
  /** Unix seconds after which the transaction can never be included. */
  maxTime: number;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export class EscrowClient {
  readonly server: rpc.Server;
  readonly config: EscrowConfig;

  constructor(config: EscrowConfig) {
    this.config = config;
    this.server = new rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
  }

  /** Builds and simulates `call` with `source` as the transaction source. */
  async prepare(source: string, call: EscrowCall): Promise<PreparedTx> {
    const account = await this.server.getAccount(source).catch((e: unknown) => {
      throw new EscrowError(`account ${source} not found on the network: ${String(e)}`, null);
    });
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(new Contract(this.config.contractId).call(call.fn, ...encodeArgs(call)))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();
    let prepared: Transaction;
    try {
      prepared = (await this.server.prepareTransaction(tx)) as Transaction;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = contractErrorFrom(message);
      throw new EscrowError(code ? `escrow rejected ${call.fn}: ${code}` : message, code);
    }
    return {
      xdr: prepared.toXdr(),
      hash: hex(prepared.hash()),
      source,
      maxTime: Number(prepared.timeBounds?.maxTime ?? 0),
    };
  }

  /** Reads a task from the contract; null if it was never funded. */
  async readTask(taskId: string): Promise<OnchainTask | null> {
    const raw = await this.view("get_task", [bytes32(taskId)]);
    return raw === null ? null : decodeTask(raw);
  }

  async view(fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal | null> {
    const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(new Contract(this.config.contractId).call(fn, ...args))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      if (contractErrorFrom(sim.error) === "TaskNotFound") return null;
      throw new EscrowError(
        `simulation of ${fn} failed: ${sim.error}`,
        contractErrorFrom(sim.error),
      );
    }
    return sim.result?.retval ?? null;
  }

  async send(tx: Transaction): Promise<rpc.Api.SendTransactionResponse> {
    return this.server.sendTransaction(tx);
  }

  async outcome(hash: string): Promise<TxOutcome> {
    const res = await this.server.getTransaction(hash);
    switch (res.status) {
      case rpc.Api.GetTransactionStatus.SUCCESS:
        return { status: "success", ledger: res.ledger };
      case rpc.Api.GetTransactionStatus.FAILED:
        return { status: "failed", ledger: res.ledger, detail: res.resultXdr.result.type };
      default:
        return { status: "not_found", latestLedgerCloseTime: Number(res.latestLedgerCloseTime) };
    }
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  /** Escrow events from `startLedger`, or continuing from `cursor`. */
  async events(from: { startLedger: number } | { cursor: string }, limit = 100) {
    const filters = [{ type: "contract" as const, contractIds: [this.config.contractId] }];
    const res = await this.server.getEvents(
      "cursor" in from
        ? { filters, cursor: from.cursor, limit }
        : { filters, startLedger: from.startLedger, limit },
    );
    return {
      cursor: res.cursor,
      latestLedger: res.latestLedger,
      oldestLedger: res.oldestLedger,
      events: res.events.map((e) => ({
        id: e.id,
        ledger: e.ledger,
        txHash: e.txHash,
        name: String(scValToNative(e.topic[0] as xdr.ScVal)),
        taskId:
          e.topic[1] !== undefined
            ? Buffer.from(scValToNative(e.topic[1]) as Uint8Array).toString("hex")
            : null,
        data: toJsonSafe(scValToNative(e.value)),
      })),
    };
  }
}

export type TxOutcome =
  | { status: "success"; ledger: number }
  | { status: "failed"; ledger: number; detail: string }
  | { status: "not_found"; latestLedgerCloseTime: number };

export function decodeTask(raw: xdr.ScVal): OnchainTask {
  const t = scValToNative(raw) as Record<string, unknown>;
  const state = ONCHAIN_STATES[Number(t.state)] as OnchainState | undefined;
  if (!state) throw new EscrowError(`unknown on-chain state ${String(t.state)}`, null);
  return {
    state,
    payee: (t.payee as string | undefined) ?? null,
    rejections: Number(t.rejections),
    submittedAt: Number(t.submitted_at),
    deadline: Number(t.deadline),
    reviewWindow: Number(t.review_window),
    amount: BigInt(t.amount as bigint),
  };
}

/**
 * Parses a signed transaction and checks it is exactly the prepared one
 * (same hash, so same operations, fees, sequence and time bounds) carrying a
 * valid signature from `signer`.
 */
export function verifySigned(
  signedXdr: string,
  expected: { hash: string; signer: string },
  networkPassphrase: string,
): Transaction {
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    if (!("operations" in parsed) || "innerTransaction" in parsed) {
      throw new Error("fee-bump transactions are not accepted");
    }
    tx = parsed as Transaction;
  } catch (e) {
    throw new EscrowError(`invalid transaction XDR: ${e instanceof Error ? e.message : e}`, null);
  }
  if (hex(tx.hash()) !== expected.hash) {
    throw new EscrowError("signed transaction does not match the prepared transaction", null);
  }
  const keypair = Keypair.fromPublicKey(expected.signer);
  const hint = hex(keypair.signatureHint());
  const signed = tx.signatures.some(
    (s) => hex(s.hint.value) === hint && keypair.verify(tx.hash(), s.signature),
  );
  if (!signed) throw new EscrowError(`transaction is not signed by ${expected.signer}`, null);
  return tx;
}

/** Converts SDK-native values (bigint, Buffer) into JSON-safe values. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

/** Maps an off-chain action to its contract function, for documentation and checks. */
export const CHAIN_FN_SIGNER: Record<ChainFn, "client" | "payee" | "arbiter" | "party"> = {
  fund: "client",
  assign: "client",
  submit: "payee",
  reject: "client",
  approve: "client",
  claim: "payee",
  abandon: "payee",
  refund: "client",
  dispute: "party",
  resolve: "arbiter",
};
