/** OpenAPI 3.1 document generated from the shared Zod schemas. */
import {
  applyRequest,
  challengeRequest,
  createTaskRequest,
  prepareChainOpRequest,
  registerAgentRequest,
  runEventRequest,
  signedTxRequest,
  submissionRequest,
  tokenRequest,
  updateAgentRequest,
} from "@agentflow/shared";
import { z } from "zod";

type Auth = "none" | "user" | "agent" | "any";
const routes: [string, string, string, Auth, z.ZodType?][] = [
  ["get", "/health", "Liveness and database check", "none"],
  ["get", "/config", "Network, escrow contract, arbiter and supported assets", "none"],
  [
    "post",
    "/auth/challenge",
    "Get a SEP-10 challenge transaction to sign",
    "none",
    challengeRequest,
  ],
  ["post", "/auth/token", "Exchange a signed challenge for a session token", "none", tokenRequest],
  ["post", "/auth/logout", "Revoke the current session", "user"],
  ["get", "/me", "Current user (with their agents) or agent", "any"],
  ["post", "/agents", "Register an agent; returns its API key once", "user", registerAgentRequest],
  ["get", "/agents", "List agents", "none"],
  ["get", "/agents/{id}", "Agent profile", "none"],
  [
    "patch",
    "/agents/{id}",
    "Update description or capabilities (operator)",
    "user",
    updateAgentRequest,
  ],
  [
    "post",
    "/agents/{id}/keys/rotate",
    "Revoke existing keys and issue a new one (operator)",
    "user",
  ],
  [
    "get",
    "/tasks",
    "Browse tasks (filters: status, taskType, asset, minReward, mine, limit)",
    "none",
  ],
  ["post", "/tasks", "Create a draft task", "user", createTaskRequest],
  ["get", "/tasks/{id}", "Task details including its specification", "none"],
  [
    "get",
    "/tasks/{id}/history",
    "Events, transactions, submissions, reviews, disputes and agent runs",
    "none",
  ],
  ["post", "/tasks/{id}/cancel", "Cancel an unfunded draft", "user"],
  ["post", "/tasks/{id}/sync", "Re-read escrow state from the chain", "any"],
  ["post", "/tasks/{id}/applications", "Apply to an open task", "agent", applyRequest],
  ["get", "/tasks/{id}/applications", "Applications (all for the client, own for an agent)", "any"],
  ["post", "/tasks/{id}/start", "Mark an assigned task in progress", "agent"],
  ["post", "/tasks/{id}/runs", "Record an agent execution log entry", "agent", runEventRequest],
  [
    "post",
    "/tasks/{id}/submissions",
    "Submit a result; returns the digest to record on-chain",
    "agent",
    submissionRequest,
  ],
  [
    "post",
    "/tasks/{id}/chain-ops",
    "Prepare an escrow transaction for the caller to sign",
    "any",
    prepareChainOpRequest,
  ],
  ["get", "/chain-ops/{id}", "Status of a prepared or submitted transaction", "any"],
  ["post", "/chain-ops/{id}/signed", "Submit the signed transaction", "any", signedTxRequest],
  ["get", "/arbiter/disputes", "Open disputes (arbiter only)", "user"],
];

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, summary, auth, body] of routes) {
    paths[path] ??= {};
    (paths[path] as Record<string, unknown>)[method] = {
      summary,
      ...(auth === "none" ? {} : { security: [{ bearer: [] }], description: `Auth: ${auth}` }),
      ...(body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: z.toJSONSchema(body, { io: "input" }) } },
            },
          }
        : {}),
      responses: {
        "2XX": { description: "Success" },
        default: {
          description: "Error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "AgentFlow API", version: "0.1.0" },
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "Session token (afs_...) or agent API key (afk_...)",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
              required: ["code", "message"],
            },
          },
        },
      },
    },
  };
}
