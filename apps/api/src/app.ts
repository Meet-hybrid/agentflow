import {
  applyRequest,
  challengeRequest,
  createTaskRequest,
  prepareChainOpRequest,
  registerAgentRequest,
  runEventRequest,
  signedTxRequest,
  submissionRequest,
  taskListQuery,
  tokenRequest,
  updateAgentRequest,
  uuid,
} from "@agentflow/shared";
import { createChallenge, type Sep10Config, verifyChallenge } from "@agentflow/stellar";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type AgentPrincipal,
  authenticate,
  createSession,
  type Principal,
  revokeSession,
  storeAgentKey,
  type UserPrincipal,
} from "./auth.ts";
import type { Config } from "./config.ts";
import { type Db, isUniqueViolation } from "./db/pool.ts";
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from "./errors.ts";
import { openApiDocument } from "./openapi.ts";
import {
  type ChainGateway,
  getOp,
  opView,
  prepareOp,
  submitSigned,
  syncTask,
} from "./services/chain.ts";
import {
  apply,
  cancelDraft,
  createSubmission,
  createTask,
  getTask,
  listApplications,
  listTasks,
  recordRun,
  startTask,
  taskHistory,
  taskView,
} from "./services/tasks.ts";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  chain: ChainGateway;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      "invalid request",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

const idParams = z.object({ id: uuid });

export function buildApp({ config, db, chain }: AppDeps) {
  const app = Fastify({
    logger:
      config.LOG_LEVEL === "silent"
        ? false
        : { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  const sep10: Sep10Config = {
    serverSecret: config.SEP10_SERVER_SECRET,
    homeDomain: config.SEP10_HOME_DOMAIN,
    webAuthDomain: config.SEP10_HOME_DOMAIN,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
  };

  app.register(helmet);
  app.register(cors, { origin: [config.WEB_ORIGIN], methods: ["GET", "POST", "PATCH", "DELETE"] });
  app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.headers.authorization?.slice(7, 40) ?? req.ip,
  });

  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (req) => {
    req.principal = await authenticate(db, req);
  });

  const user = (req: FastifyRequest): UserPrincipal => {
    if (req.principal?.kind !== "user") throw unauthorized("sign in with a Stellar wallet");
    return req.principal;
  };
  const agent = (req: FastifyRequest): AgentPrincipal => {
    if (req.principal?.kind !== "agent") throw unauthorized("authenticate with an agent API key");
    return req.principal;
  };
  const anyone = (req: FastifyRequest): Principal => {
    if (!req.principal) throw unauthorized();
    return req.principal;
  };

  app.setErrorHandler(
    (err: Error & { statusCode?: number; code?: string }, req, reply: FastifyReply) => {
      if (err instanceof ApiError) {
        return reply
          .status(err.status)
          .send({ error: { code: err.code, message: err.message, details: err.details } });
      }
      if (err.statusCode === 429) {
        return reply.status(429).send({ error: { code: "RATE_LIMITED", message: err.message } });
      }
      if (err.statusCode && err.statusCode < 500) {
        return reply
          .status(err.statusCode)
          .send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } });
      }
      req.log.error({ err }, "unhandled error");
      return reply.status(500).send({ error: { code: "INTERNAL", message: "internal error" } });
    },
  );

  // ----- Meta -----------------------------------------------------------------

  app.get("/health", async () => {
    await db.query("select 1");
    return { ok: true };
  });

  app.get("/config", async () => ({
    network: config.STELLAR_NETWORK_PASSPHRASE,
    rpcUrl: config.STELLAR_RPC_URL,
    escrowContractId: config.ESCROW_CONTRACT_ID,
    arbiter: config.ARBITER_ADDRESS,
    assets: config.ASSETS,
  }));

  app.get("/openapi.json", async () => openApiDocument());

  // ----- Auth -----------------------------------------------------------------

  const authLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.post("/auth/challenge", authLimit, async (req) => {
    const { address } = parse(challengeRequest, req.body);
    return {
      transaction: createChallenge(sep10, address),
      networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    };
  });

  app.post("/auth/token", authLimit, async (req) => {
    const { transaction } = parse(tokenRequest, req.body);
    let address: string;
    try {
      address = verifyChallenge(sep10, transaction);
    } catch (e) {
      throw unauthorized(`challenge rejected: ${(e as Error).message}`);
    }
    const hash = Buffer.from(
      TransactionBuilder.fromXDR(transaction, config.STELLAR_NETWORK_PASSPHRASE).hash(),
    ).toString("hex");
    try {
      await db.query("insert into used_challenges (tx_hash) values ($1)", [hash]);
    } catch (e) {
      if (isUniqueViolation(e)) throw unauthorized("challenge already used");
      throw e;
    }
    const { rows } = await db.query<{ id: string }>(
      `insert into users (stellar_address) values ($1)
       on conflict (stellar_address) do update set stellar_address = excluded.stellar_address returning id`,
      [address],
    );
    const userId = (rows[0] as { id: string }).id;
    const session = await createSession(db, userId, config.SESSION_TTL_HOURS);
    return {
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      user: { id: userId, address },
    };
  });

  app.post("/auth/logout", async (req) => {
    await revokeSession(db, req);
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const who = anyone(req);
    if (who.kind === "agent") return { kind: "agent", agent: await agentView(db, who.id) };
    const { rows } = await db.query(
      "select id, name, payout_address, status, capabilities, created_at from agents where operator_id = $1 order by created_at",
      [who.id],
    );
    return {
      kind: "user",
      user: { id: who.id, address: who.address, isArbiter: who.address === config.ARBITER_ADDRESS },
      agents: rows,
    };
  });

  // ----- Agents ---------------------------------------------------------------

  app.post("/agents", async (req, reply) => {
    const operator = user(req);
    const body = parse(registerAgentRequest, req.body);
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into agents (operator_id, name, description, payout_address, capabilities)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          operator.id,
          body.name,
          body.description,
          body.payoutAddress,
          JSON.stringify(body.capabilities),
        ],
      );
      const id = (rows[0] as { id: string }).id;
      const apiKey = await storeAgentKey(db, id);
      reply.status(201);
      return { agent: await agentView(db, id), apiKey };
    } catch (e) {
      if (isUniqueViolation(e))
        throw conflict("NAME_TAKEN", "you already have an agent with that name");
      throw e;
    }
  });

  app.get("/agents", async () => {
    const { rows } = await db.query(
      `select a.id, a.name, a.description, a.payout_address, a.capabilities, a.status, u.stellar_address as operator,
         (select count(*) from tasks t where t.assigned_agent_id = a.id and t.status = 'paid')::int as tasks_paid
       from agents a join users u on u.id = a.operator_id order by a.created_at desc limit 200`,
    );
    return rows;
  });

  app.get("/agents/:id", async (req) => agentView(db, parse(idParams, req.params).id));

  app.patch("/agents/:id", async (req) => {
    const operator = user(req);
    const { id } = parse(idParams, req.params);
    const body = parse(updateAgentRequest, req.body);
    const { rowCount } = await db.query(
      `update agents set description = coalesce($3, description), capabilities = coalesce($4, capabilities),
         updated_at = now() where id = $1 and operator_id = $2`,
      [
        id,
        operator.id,
        body.description ?? null,
        body.capabilities ? JSON.stringify(body.capabilities) : null,
      ],
    );
    if (!rowCount) throw notFound("agent");
    return agentView(db, id);
  });

  app.post("/agents/:id/keys/rotate", async (req) => {
    const operator = user(req);
    const { id } = parse(idParams, req.params);
    const owned = await db.query("select 1 from agents where id = $1 and operator_id = $2", [
      id,
      operator.id,
    ]);
    if (!owned.rowCount) throw notFound("agent");
    await db.query(
      "update agent_keys set revoked_at = now() where agent_id = $1 and revoked_at is null",
      [id],
    );
    return { apiKey: await storeAgentKey(db, id) };
  });

  // ----- Tasks ----------------------------------------------------------------

  app.get("/tasks", async (req) =>
    listTasks(db, config, req.principal, parse(taskListQuery, req.query)),
  );

  app.post("/tasks", async (req, reply) => {
    const task = await createTask(db, config, user(req), parse(createTaskRequest, req.body));
    reply.status(201);
    return taskView(config, task, { includeSpec: true });
  });

  app.get("/tasks/:id", async (req) => {
    const task = await getTask(db, parse(idParams, req.params).id);
    const who = req.principal;
    if (task.status === "draft" && !(who?.kind === "user" && who.id === task.client_id))
      throw notFound("task");
    return taskView(config, task, { includeSpec: true });
  });

  app.get("/tasks/:id/history", async (req) => {
    const { id } = parse(idParams, req.params);
    const history = await taskHistory(db, config, req.principal, id);
    const who = req.principal;
    if (
      history.task.status === "draft" &&
      !(who?.kind === "user" && who.id === history.task.client.id)
    ) {
      throw notFound("task");
    }
    return history;
  });

  app.post("/tasks/:id/cancel", async (req) =>
    taskView(config, await cancelDraft(db, user(req), parse(idParams, req.params).id), {
      includeSpec: true,
    }),
  );

  app.post(
    "/tasks/:id/sync",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      anyone(req);
      const task = await syncTask(db, chain, parse(idParams, req.params).id);
      return taskView(config, task, { includeSpec: true });
    },
  );

  app.post("/tasks/:id/applications", async (req, reply) => {
    const { message } = parse(applyRequest, req.body ?? {});
    reply.status(201);
    return apply(db, agent(req), parse(idParams, req.params).id, message);
  });

  app.get("/tasks/:id/applications", async (req) =>
    listApplications(db, anyone(req), parse(idParams, req.params).id),
  );

  app.post("/tasks/:id/start", async (req) =>
    taskView(config, await startTask(db, agent(req), parse(idParams, req.params).id), {
      includeSpec: true,
    }),
  );

  app.post("/tasks/:id/runs", async (req, reply) => {
    await recordRun(
      db,
      agent(req),
      parse(idParams, req.params).id,
      parse(runEventRequest, req.body),
    );
    reply.status(201);
    return { ok: true };
  });

  app.post("/tasks/:id/submissions", async (req, reply) => {
    const submission = await createSubmission(
      db,
      agent(req),
      parse(idParams, req.params).id,
      parse(submissionRequest, req.body),
    );
    reply.status(201);
    return submission;
  });

  // ----- Chain operations -------------------------------------------------------

  app.post("/tasks/:id/chain-ops", async (req, reply) => {
    const op = await prepareOp(
      db,
      config,
      chain,
      anyone(req),
      parse(idParams, req.params).id,
      parse(prepareChainOpRequest, req.body),
    );
    reply.status(201);
    return op;
  });

  app.get("/chain-ops/:id", async (req) =>
    opView(await getOp(db, anyone(req), parse(idParams, req.params).id)),
  );

  app.post("/chain-ops/:id/signed", async (req) => {
    const { signedXdr } = parse(signedTxRequest, req.body);
    return submitSigned(db, config, chain, anyone(req), parse(idParams, req.params).id, signedXdr);
  });

  app.get("/arbiter/disputes", async (req) => {
    const who = user(req);
    if (who.address !== config.ARBITER_ADDRESS) throw forbidden("arbiter only");
    const { rows } = await db.query(
      `select d.id, d.task_id, d.reason, d.opened_by_type, d.created_at, t.title, t.amount, t.asset_code
       from disputes d join tasks t on t.id = d.task_id where d.status = 'open' order by d.created_at`,
    );
    return rows;
  });

  return app;
}

async function agentView(db: Db, id: string) {
  const { rows } = await db.query(
    `select a.id, a.name, a.description, a.payout_address, a.capabilities, a.status, a.created_at,
       u.stellar_address as operator
     from agents a join users u on u.id = a.operator_id where a.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound("agent");
  return rows[0];
}
