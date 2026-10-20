/**
 * In-memory stand-in for the escrow contract, for backend tests only.
 *
 * It mirrors the contract's state rules and builds and verifies real Stellar
 * transactions, so the API's signing checks are exercised for real. It is NOT
 * evidence of Stellar integration; that is covered by the testnet E2E script.
 */
import type { OnchainTask } from "@agentflow/shared";
import {
  type EscrowCall,
  EscrowError,
  encodeArgs,
  type PreparedTx,
  type TxOutcome,
} from "@agentflow/stellar";
import {
  Account,
  BASE_FEE,
  Contract,
  type Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { ChainGateway } from "../src/services/chain.ts";

type Mode = "include" | "fail" | "drop" | "send_error" | "try_later";

export class FakeChain implements ChainGateway {
  tasks = new Map<string, OnchainTask & { client: string }>();
  private pending = new Map<string, { source: string; call: EscrowCall }>();
  private results = new Map<string, TxOutcome>();
  private seq = new Map<string, bigint>();
  /** Transactions the network keeps ignoring until `include` is called. */
  private dropped = new Set<string>();
  /** What happens to the next transaction that is sent. */
  next: Mode = "include";
  now = Math.floor(Date.now() / 1000);
  closeTime = this.now;
  sent: string[] = [];

  readonly contractId: string;
  readonly passphrase: string;
  readonly reviewWindow: number;

  constructor(contractId: string, passphrase: string, reviewWindow = 3600) {
    this.contractId = contractId;
    this.passphrase = passphrase;
    this.reviewWindow = reviewWindow;
  }

  async prepare(source: string, call: EscrowCall): Promise<PreparedTx> {
    this.check(source, call); // simulation fails like the contract would
    const seq = this.seq.get(source) ?? 100n;
    this.seq.set(source, seq + 1n);
    const tx = new TransactionBuilder(new Account(source, seq.toString()), {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(this.contractId).call(call.fn, ...encodeArgs(call)))
      .setTimeout(300)
      .build();
    const hash = Buffer.from(tx.hash()).toString("hex");
    this.pending.set(hash, { source, call });
    return { xdr: tx.toXdr(), hash, source, maxTime: Number(tx.timeBounds?.maxTime) };
  }

  async readTask(id: string) {
    const t = this.tasks.get(id);
    if (!t) return null;
    const { client: _client, ...rest } = t;
    return { ...rest };
  }

  async send(signedXdr: string) {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.passphrase) as Transaction;
    const hash = Buffer.from(tx.hash()).toString("hex");
    this.sent.push(hash);
    const mode = this.next;
    this.next = "include";
    const entry = this.pending.get(hash);
    if (this.dropped.has(hash)) return { status: "PENDING" };
    if (mode === "send_error") return { status: "ERROR", error: "txBadSeq" };
    if (mode === "try_later") return { status: "TRY_AGAIN_LATER" };
    if (mode === "drop") {
      this.dropped.add(hash);
      return { status: "PENDING" };
    }
    if (mode === "fail" || !entry) {
      this.results.set(hash, { status: "failed", ledger: 1, detail: "txFailed" });
      return { status: "PENDING" };
    }
    this.include(hash);
    return { status: "PENDING" };
  }

  /** Includes a previously sent or dropped transaction. */
  include(hash: string) {
    const entry = this.pending.get(hash);
    if (!entry) throw new Error("unknown tx");
    this.dropped.delete(hash);
    try {
      this.check(entry.source, entry.call);
      this.apply(entry.source, entry.call);
      this.results.set(hash, { status: "success", ledger: 1 });
    } catch {
      this.results.set(hash, { status: "failed", ledger: 1, detail: "txFailed" });
    }
  }

  async outcome(hash: string): Promise<TxOutcome> {
    return this.results.get(hash) ?? { status: "not_found", latestLedgerCloseTime: this.closeTime };
  }

  /** A contract call made outside the API (e.g. from the Stellar CLI). */
  direct(source: string, call: EscrowCall) {
    this.check(source, call);
    this.apply(source, call);
  }

  private fail(code: string): never {
    throw new EscrowError(`escrow rejected: ${code}`, code);
  }

  private check(source: string, call: EscrowCall) {
    const t = this.tasks.get(call.taskId);
    if (call.fn === "fund") {
      if (t) this.fail("TaskExists");
      if (source !== call.client) this.fail("Auth");
      return;
    }
    if (!t) this.fail("TaskNotFound");
    const need = (state: OnchainTask["state"], who: string | null) => {
      if (t.state !== state) this.fail("InvalidState");
      if (who !== source) this.fail("Auth");
    };
    switch (call.fn) {
      case "assign":
        return need("Funded", t.client);
      case "submit":
        return need("Assigned", t.payee);
      case "reject":
      case "approve":
        return need("Submitted", t.client);
      case "claim":
        need("Submitted", t.payee);
        if (this.now < t.submittedAt + t.reviewWindow) this.fail("ReviewWindowOpen");
        return;
      case "abandon":
        if (t.state !== "Assigned" && t.state !== "Submitted") this.fail("InvalidState");
        if (source !== t.payee) this.fail("Auth");
        return;
      case "refund":
        if (source !== t.client) this.fail("Auth");
        if (t.state === "Funded") return;
        if (t.state === "Assigned" && this.now > t.deadline) return;
        return this.fail(t.state === "Assigned" ? "DeadlineNotPassed" : "InvalidState");
      case "dispute":
        if (t.state !== "Assigned" && t.state !== "Submitted") this.fail("InvalidState");
        if (call.by !== source || (source !== t.client && source !== t.payee))
          this.fail("NotParty");
        return;
      case "resolve":
        return need("Disputed", source);
    }
  }

  private apply(_source: string, call: EscrowCall) {
    if (call.fn === "fund") {
      this.tasks.set(call.taskId, {
        state: "Funded",
        client: call.client,
        payee: null,
        rejections: 0,
        submittedAt: 0,
        deadline: call.deadline,
        reviewWindow: this.reviewWindow,
        amount: call.amount,
      });
      return;
    }
    const t = this.tasks.get(call.taskId) as OnchainTask & { client: string };
    switch (call.fn) {
      case "assign":
        Object.assign(t, { state: "Assigned", payee: call.payee });
        break;
      case "submit":
        Object.assign(t, { state: "Submitted", submittedAt: this.now });
        break;
      case "reject":
        Object.assign(t, { state: "Assigned", rejections: t.rejections + 1, submittedAt: 0 });
        break;
      case "approve":
      case "claim":
        t.state = "Released";
        break;
      case "abandon":
        Object.assign(t, { state: "Funded", payee: null, submittedAt: 0 });
        break;
      case "refund":
        t.state = "Refunded";
        break;
      case "dispute":
        t.state = "Disputed";
        break;
      case "resolve":
        t.state = "Resolved";
        break;
    }
  }
}
