import { type CsvAggregateSpec, hashJson, runCsvAggregate } from "@agentflow/shared";
import { Keypair, Networks, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPool, type Db } from "../src/db/pool.ts";
import { FakeChain } from "./fake-chain.ts";

export const PASS = Networks.TESTNET;
const DB_URL =
  process.env.AGENTFLOW_TEST_DATABASE_URL ??
  "postgres://agentflow:agentflow-dev@127.0.0.1:55432/agentflow_test";

export interface Harness {
  app: FastifyInstance;
  db: Db;
  chain: FakeChain;
  arbiter: Keypair;
  close(): Promise<void>;
}

export async function setup(): Promise<Harness> {
  const db = createPool(DB_URL);
  await db.query("drop schema public cascade; create schema public;");
  await migrate(db);
  const arbiter = Keypair.random();
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 9));
  const config = loadConfig({
    DATABASE_URL: DB_URL,
    ESCROW_CONTRACT_ID: contractId,
    ARBITER_ADDRESS: arbiter.publicKey(),
    ASSETS: JSON.stringify([
      { code: "XLM", contractId: StrKey.encodeContract(Buffer.alloc(32, 1)), decimals: 7 },
    ]),
    SEP10_SERVER_SECRET: Keypair.random().secret(),
    LOG_LEVEL: "silent",
  });
  const chain = new FakeChain(contractId, PASS);
  const app = buildApp({ config, db, chain });
  await app.ready();
  return {
    app,
    db,
    chain,
    arbiter,
    async close() {
      await app.close();
      await db.end();
    },
  };
}

export type Who = { token: string; kp: Keypair };

export async function call(
  h: Harness,
  method: string,
  url: string,
  who?: Who | string | null,
  body?: unknown,
) {
  const token = typeof who === "string" ? who : who?.token;
  const res = await h.app.inject({
    method: method as "GET",
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

export async function signIn(h: Harness, kp = Keypair.random()): Promise<Who> {
  const ch = await call(h, "POST", "/auth/challenge", null, { address: kp.publicKey() });
  const tx = TransactionBuilder.fromXDR(ch.body.transaction, PASS);
  tx.sign(kp);
  const res = await call(h, "POST", "/auth/token", null, { transaction: tx.toXdr() });
  if (res.status !== 200) throw new Error(`sign in failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, kp };
}

export function sign(xdr: string, kp: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, PASS);
  tx.sign(kp);
  return tx.toXdr();
}

export const SPEC: CsvAggregateSpec = {
  type: "csv-aggregate",
  version: 1,
  csv: "region,amount\neu,10.50\nus,3\neu,0.25\n",
  groupBy: "region",
  metrics: [
    { column: "amount", op: "sum" },
    { column: "amount", op: "count" },
  ],
  decimals: 2,
};

export function taskBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Aggregate sales by region",
    description: "Sum and count sales amounts per region.",
    acceptanceCriteria: "Output matches a deterministic recomputation.",
    spec: SPEC,
    reward: { asset: "XLM", amount: "12.5" },
    deadline: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    ...overrides,
  };
}

/** Prepares, signs and submits a chain op, then lets the worker confirm it. */
export async function chainOp(
  h: Harness,
  taskId: string,
  who: Who | { token: string; kp: Keypair },
  req: object,
) {
  const prep = await call(h, "POST", `/tasks/${taskId}/chain-ops`, who.token, req);
  if (prep.status !== 201) return prep;
  return call(h, "POST", `/chain-ops/${prep.body.id}/signed`, who.token, {
    signedXdr: sign(prep.body.xdr, who.kp),
  });
}

export async function buildSubmission(spec: CsvAggregateSpec, key: string = crypto.randomUUID()) {
  const output = runCsvAggregate(spec);
  return {
    idempotencyKey: key,
    output,
    evidence: {
      executor: "test",
      specSha256: await hashJson(spec),
      outputSha256: await hashJson(output),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1,
    },
  };
}
