#!/usr/bin/env node
/**
 * AgentFlow reference agent.
 *
 *   node src/cli.ts run    # poll forever
 *   node src/cli.ts once   # a single discovery/work pass
 *
 * Configuration (environment):
 *   AGENTFLOW_API_URL          API base URL (default http://127.0.0.1:8787)
 *   AGENTFLOW_AGENT_KEY        agent API key (afk_...)
 *   AGENT_PAYOUT_SECRET_FILE   file holding the payout account secret (preferred, mode 600)
 *   AGENT_PAYOUT_SECRET        or the secret itself (testnet only)
 *   AGENT_MIN_REWARD           minimum reward to apply for (default 1)
 *   AGENT_POLL_SECONDS         poll interval for `run` (default 15)
 *   AGENT_STATE_DIR            local state directory (default ./.agent-state)
 *   AGENT_MAX_FEE_STROOPS      highest fee the agent will sign (default 50000000 = 5 XLM)
 */
import { readFile, stat } from "node:fs/promises";
import { ReferenceAgent } from "./agent.ts";

async function payoutSecret(): Promise<string> {
  const file = process.env.AGENT_PAYOUT_SECRET_FILE;
  if (file) {
    const mode = (await stat(file)).mode & 0o777;
    if (mode & 0o077) throw new Error(`${file} must not be readable by group or others (chmod 600)`);
    return (await readFile(file, "utf8")).trim();
  }
  const secret = process.env.AGENT_PAYOUT_SECRET;
  if (!secret) throw new Error("set AGENT_PAYOUT_SECRET_FILE (or AGENT_PAYOUT_SECRET for testnet)");
  return secret;
}

const command = process.argv[2] ?? "run";
const key = process.env.AGENTFLOW_AGENT_KEY;
if (!key) {
  console.error("AGENTFLOW_AGENT_KEY is required");
  process.exit(2);
}

const agent = new ReferenceAgent({
  apiUrl: process.env.AGENTFLOW_API_URL ?? "http://127.0.0.1:8787",
  apiKey: key,
  payoutSecret: await payoutSecret(),
  minReward: process.env.AGENT_MIN_REWARD ?? "1",
  stateDir: process.env.AGENT_STATE_DIR ?? ".agent-state",
  maxExecutionAttempts: 3,
  maxFeeStroops: BigInt(process.env.AGENT_MAX_FEE_STROOPS ?? "50000000"),
});
await agent.init();
if (command === "once") {
  await agent.runOnce();
} else if (command === "run") {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  await agent.runForever(Number(process.env.AGENT_POLL_SECONDS ?? 15), controller.signal);
} else {
  console.error(`unknown command ${command}; use run or once`);
  process.exit(2);
}
