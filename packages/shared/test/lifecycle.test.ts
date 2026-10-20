import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  type Action,
  applyOffchain,
  checkAction,
  type OnchainTask,
  type Role,
  statusFromChain,
  TASK_STATUSES,
  TERMINAL_STATUSES,
} from "../src/index.ts";

const ROLES: Role[] = ["client", "agent", "arbiter", "system"];
const onchain = (state: OnchainTask["state"], rejections = 0): OnchainTask => ({
  state,
  payee: "GPAYEE",
  rejections,
  submittedAt: 0,
  deadline: 0,
  reviewWindow: 3600,
  amount: 10n,
});

describe("checkAction", () => {
  it("allows exactly the listed (role, status) pairs for every action", () => {
    for (const [action, rule] of Object.entries(ACTIONS) as [Action, (typeof ACTIONS)[Action]][]) {
      for (const role of ROLES) {
        for (const status of TASK_STATUSES) {
          const err = checkAction(action, status, role);
          const allowed = rule.roles.includes(role) && rule.from.includes(status);
          expect(err === null, `${role} ${action} on ${status}`).toBe(allowed);
          if (!rule.roles.includes(role)) expect(err?.code).toBe("FORBIDDEN");
        }
      }
    }
  });

  it("never allows any action on a terminal task", () => {
    for (const action of Object.keys(ACTIONS) as Action[]) {
      for (const status of TERMINAL_STATUSES) {
        for (const role of ROLES) expect(checkAction(action, status, role)).not.toBeNull();
      }
    }
  });

  it("only the client can approve or refund, only the arbiter can resolve", () => {
    expect(checkAction("approve", "under_review", "agent")?.code).toBe("FORBIDDEN");
    expect(checkAction("approve", "under_review", "client")).toBeNull();
    expect(checkAction("refund", "open", "agent")?.code).toBe("FORBIDDEN");
    expect(checkAction("resolve", "disputed", "client")?.code).toBe("FORBIDDEN");
    expect(checkAction("resolve", "disputed", "arbiter")).toBeNull();
  });

  it("cannot approve before a submission exists", () => {
    for (const status of ["draft", "open", "assigned", "in_progress", "rejected"] as const) {
      expect(checkAction("approve", status, "client")?.code).toBe("INVALID_STATE");
    }
  });
});

describe("applyOffchain", () => {
  it("applies off-chain transitions", () => {
    expect(applyOffchain("start", "assigned", "agent")).toBe("in_progress");
    expect(applyOffchain("mark_verified", "submitted", "system")).toBe("under_review");
    expect(applyOffchain("cancel_draft", "draft", "client")).toBe("cancelled");
  });

  it("refuses money-moving actions", () => {
    expect(() => applyOffchain("approve", "under_review", "client")).toThrow(/on-chain/);
    expect(() => applyOffchain("refund", "open", "client")).toThrow(/on-chain/);
  });

  it("refuses invalid off-chain transitions", () => {
    expect(() => applyOffchain("start", "open", "agent")).toThrow();
    expect(() => applyOffchain("start", "assigned", "client")).toThrow();
  });
});

describe("statusFromChain", () => {
  it("keeps unfunded drafts as drafts and corrects anything else", () => {
    expect(statusFromChain("draft", null, 0, false)).toBeNull();
    expect(statusFromChain("open", null, 0, false)).toBe("draft");
  });

  it("only marks a task paid when the escrow is released", () => {
    expect(statusFromChain("approved", onchain("Submitted"), 0, true)).toBeNull();
    expect(statusFromChain("approved", onchain("Released"), 0, true)).toBe("paid");
    expect(statusFromChain("paid", onchain("Released"), 0, false)).toBeNull();
  });

  it("reverts a stale approval when no release is in flight", () => {
    expect(statusFromChain("approved", onchain("Submitted"), 0, false)).toBe("under_review");
  });

  it("detects rejections and abandonment from the chain", () => {
    expect(statusFromChain("under_review", onchain("Assigned", 1), 0, false)).toBe("rejected");
    expect(statusFromChain("rejected", onchain("Assigned", 1), 1, false)).toBeNull();
    expect(statusFromChain("in_progress", onchain("Funded"), 0, false)).toBe("open");
  });

  it("keeps finer off-chain states that agree with the chain", () => {
    expect(statusFromChain("in_progress", onchain("Assigned"), 0, false)).toBeNull();
    expect(statusFromChain("under_review", onchain("Submitted"), 0, false)).toBeNull();
  });

  it("maps every terminal on-chain state", () => {
    expect(statusFromChain("disputed", onchain("Resolved"), 0, false)).toBe("resolved");
    expect(statusFromChain("open", onchain("Refunded"), 0, false)).toBe("refunded");
    expect(statusFromChain("under_review", onchain("Disputed"), 0, false)).toBe("disputed");
  });
});
