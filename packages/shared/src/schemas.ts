/** Request/response schemas shared by the API, web app and agents. */
import { z } from "zod";
import { csvAggregateSpecSchema } from "./csv-aggregate.ts";
import { TASK_STATUSES } from "./lifecycle.ts";

export const stellarAddress = z.string().regex(/^G[A-Z2-7]{55}$/, "must be a Stellar account (G...)");
export const uuid = z.uuid();
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);

/** Positive decimal amount with at most 7 decimals (Stellar asset precision). */
export const decimalAmount = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, "amount must be a decimal with at most 7 places")
  .refine((s) => /[1-9]/.test(s), "amount must be greater than zero");

// ----- Auth -------------------------------------------------------------------

export const challengeRequest = z.object({ address: stellarAddress });
export const tokenRequest = z.object({ transaction: z.string().min(1).max(10_000) });

// ----- Agents -----------------------------------------------------------------

export const capabilitySchema = z.object({
  taskType: z.literal("csv-aggregate"),
  maxRows: z.number().int().positive().max(10_000).optional(),
});

export const registerAgentRequest = z.object({
  name: z.string().trim().min(3).max(60),
  description: z.string().trim().max(1000).default(""),
  payoutAddress: stellarAddress,
  capabilities: z.array(capabilitySchema).min(1).max(10),
});

export const updateAgentRequest = registerAgentRequest
  .pick({ description: true, capabilities: true })
  .partial();

// ----- Tasks ------------------------------------------------------------------

export const createTaskRequest = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(1).max(4000),
  acceptanceCriteria: z.string().trim().min(1).max(4000),
  spec: csvAggregateSpecSchema,
  reward: z.object({ asset: z.string().min(1).max(12), amount: decimalAmount }),
  deadline: z.iso.datetime({ offset: true }),
  constraints: z
    .object({ maxDurationSeconds: z.number().int().min(1).max(600).default(60) })
    .default({ maxDurationSeconds: 60 }),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequest>;

export const taskListQuery = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  taskType: z.literal("csv-aggregate").optional(),
  asset: z.string().max(12).optional(),
  minReward: decimalAmount.optional(),
  mine: z.enum(["client", "agent"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const applyRequest = z.object({ message: z.string().trim().max(1000).default("") });

export const submissionRequest = z.object({
  idempotencyKey: z.string().min(8).max(100),
  output: z.object({
    columns: z.array(z.string().max(200)).max(20),
    rows: z.array(z.array(z.string().max(200)).max(20)).max(10_000),
    inputRows: z.number().int().nonnegative(),
  }),
  evidence: z.object({
    executor: z.string().max(100),
    specSha256: hex32,
    outputSha256: hex32,
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().int().nonnegative(),
  }),
});

export const runEventRequest = z.object({
  status: z.enum(["evaluating", "accepted", "declined", "executing", "succeeded", "failed", "submitted"]),
  message: z.string().max(2000),
  detail: z.record(z.string(), z.unknown()).optional(),
});

// ----- Chain operations -------------------------------------------------------

export const CHAIN_ACTIONS = [
  "fund",
  "accept_application",
  "submit",
  "approve",
  "reject",
  "claim",
  "abandon",
  "refund",
  "dispute",
  "resolve",
] as const;

export const prepareChainOpRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("fund") }),
  z.object({ action: z.literal("accept_application"), applicationId: uuid }),
  z.object({ action: z.literal("submit"), submissionId: uuid }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal("claim") }),
  z.object({ action: z.literal("abandon") }),
  z.object({ action: z.literal("refund") }),
  z.object({ action: z.literal("dispute"), reason: z.string().trim().min(1).max(2000) }),
  z.object({
    action: z.literal("resolve"),
    payeeBps: z.number().int().min(0).max(10_000),
    reason: z.string().trim().min(1).max(2000),
  }),
]);
export type PrepareChainOpRequest = z.infer<typeof prepareChainOpRequest>;

export const signedTxRequest = z.object({ signedXdr: z.string().min(1).max(20_000) });

export const CHAIN_OP_STATUSES = [
  "prepared",
  "submitted",
  "confirmed",
  "failed",
  "expired",
] as const;
export type ChainOpStatus = (typeof CHAIN_OP_STATUSES)[number];

// ----- Errors -----------------------------------------------------------------

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
