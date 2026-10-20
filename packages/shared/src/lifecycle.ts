/**
 * Task lifecycle shared by the API, web app and agents.
 *
 * Money-moving transitions are never applied directly: the API prepares a
 * Soroban transaction, the responsible party signs it, and the database only
 * changes once the chain confirms it (see `statusFromChain`). Off-chain-only
 * transitions (start, verification, cancelling an unfunded draft) change the
 * database immediately.
 */

export const TASK_STATUSES = [
  "draft",
  "open",
  "assigned",
  "in_progress",
  "submitted",
  "under_review",
  "approved",
  "paid",
  "rejected",
  "disputed",
  "resolved",
  "cancelled",
  "refunded",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "paid",
  "resolved",
  "cancelled",
  "refunded",
];

export type Role = "client" | "agent" | "arbiter" | "system";

/** Contract functions, as named in contracts/escrow. */
export type ChainFn =
  | "fund"
  | "assign"
  | "submit"
  | "reject"
  | "approve"
  | "claim"
  | "abandon"
  | "refund"
  | "dispute"
  | "resolve";

export type Action =
  | "fund"
  | "cancel_draft"
  | "accept_application"
  | "start"
  | "submit"
  | "mark_verified"
  | "approve"
  | "reject"
  | "claim"
  | "abandon"
  | "refund"
  | "dispute"
  | "resolve";

interface ActionRule {
  from: readonly TaskStatus[];
  roles: readonly Role[];
  /** Contract call that performs the action, or null for off-chain actions. */
  chain: ChainFn | null;
  /** Off-chain actions only: the status they move to. */
  to?: TaskStatus;
  /** Status shown while the signed transaction is in flight. */
  pending?: TaskStatus;
}

const ACTIVE_WORK: readonly TaskStatus[] = ["assigned", "in_progress", "rejected"];
const AWAITING_REVIEW: readonly TaskStatus[] = ["submitted", "under_review"];

export const ACTIONS: Record<Action, ActionRule> = {
  fund: { from: ["draft"], roles: ["client"], chain: "fund" },
  cancel_draft: { from: ["draft"], roles: ["client"], chain: null, to: "cancelled" },
  accept_application: { from: ["open"], roles: ["client"], chain: "assign" },
  start: { from: ["assigned", "rejected"], roles: ["agent"], chain: null, to: "in_progress" },
  submit: { from: ACTIVE_WORK, roles: ["agent"], chain: "submit" },
  mark_verified: { from: ["submitted"], roles: ["system"], chain: null, to: "under_review" },
  approve: { from: AWAITING_REVIEW, roles: ["client"], chain: "approve", pending: "approved" },
  reject: { from: AWAITING_REVIEW, roles: ["client"], chain: "reject" },
  claim: { from: AWAITING_REVIEW, roles: ["agent"], chain: "claim" },
  abandon: { from: [...ACTIVE_WORK, ...AWAITING_REVIEW], roles: ["agent"], chain: "abandon" },
  refund: { from: ["open", ...ACTIVE_WORK], roles: ["client"], chain: "refund" },
  dispute: {
    from: [...ACTIVE_WORK, ...AWAITING_REVIEW],
    roles: ["client", "agent"],
    chain: "dispute",
  },
  resolve: { from: ["disputed"], roles: ["arbiter"], chain: "resolve" },
};

export type TransitionError =
  | { code: "FORBIDDEN"; message: string }
  | { code: "INVALID_STATE"; message: string };

/**
 * Checks whether `role` may perform `action` on a task in `status`.
 * Timing rules (deadlines, review windows) are enforced by the contract.
 */
export function checkAction(
  action: Action,
  status: TaskStatus,
  role: Role,
): TransitionError | null {
  const rule = ACTIONS[action];
  if (!rule.roles.includes(role)) {
    return { code: "FORBIDDEN", message: `${role} cannot ${action} a task` };
  }
  if (!rule.from.includes(status)) {
    return { code: "INVALID_STATE", message: `cannot ${action} a task that is ${status}` };
  }
  return null;
}

/** Applies an off-chain action, returning the new status. */
export function applyOffchain(action: Action, status: TaskStatus, role: Role): TaskStatus {
  const rule = ACTIONS[action];
  if (rule.chain !== null || !rule.to) {
    throw new Error(`${action} requires an on-chain transaction`);
  }
  const error = checkAction(action, status, role);
  if (error) throw new Error(error.message);
  return rule.to;
}

// ---------------------------------------------------------------------------
// Chain → database reconciliation
// ---------------------------------------------------------------------------

/** `TaskState` in contracts/escrow, by discriminant. */
export const ONCHAIN_STATES = [
  "Funded",
  "Assigned",
  "Submitted",
  "Released",
  "Refunded",
  "Disputed",
  "Resolved",
] as const;
export type OnchainState = (typeof ONCHAIN_STATES)[number];

export interface OnchainTask {
  state: OnchainState;
  payee: string | null;
  rejections: number;
  submittedAt: number;
  deadline: number;
  reviewWindow: number;
  amount: bigint;
}

/**
 * Derives the database status implied by the escrow's on-chain state.
 * Returns null when the current status is already consistent with it.
 *
 * The chain is authoritative for money: a task is only open once funded,
 * only paid once released, and so on. Finer off-chain distinctions
 * (in_progress vs assigned, under_review vs submitted) are kept when they
 * agree with the chain.
 */
export function statusFromChain(
  current: TaskStatus,
  onchain: OnchainTask | null,
  knownRejections: number,
  approvalInFlight: boolean,
): TaskStatus | null {
  if (onchain === null) {
    // Never funded. Anything beyond draft/cancelled would be inconsistent.
    return current === "draft" || current === "cancelled" ? null : "draft";
  }
  switch (onchain.state) {
    case "Funded":
      return current === "open" ? null : "open";
    case "Assigned":
      if (onchain.rejections > knownRejections) return current === "rejected" ? null : "rejected";
      if (current === "assigned" || current === "in_progress" || current === "rejected") {
        return null;
      }
      return "assigned";
    case "Submitted":
      // "approved" only means a release transaction is in flight; without
      // one, the task is still waiting for review.
      if (current === "approved") return approvalInFlight ? null : "under_review";
      if (current === "submitted" || current === "under_review") return null;
      return "submitted";
    case "Released":
      return current === "paid" ? null : "paid";
    case "Refunded":
      return current === "refunded" ? null : "refunded";
    case "Disputed":
      return current === "disputed" ? null : "disputed";
    case "Resolved":
      return current === "resolved" ? null : "resolved";
  }
}
