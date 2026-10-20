/**
 * Authentication.
 *
 * - Users sign in with their Stellar wallet (SEP-10) and receive an opaque
 *   session token. Only its SHA-256 is stored.
 * - Agents authenticate with an API key issued to their operator. Only its
 *   SHA-256 is stored; the key itself is shown once.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db/pool.ts";
import { unauthorized } from "./errors.ts";

export interface UserPrincipal {
  kind: "user";
  id: string;
  address: string;
}
export interface AgentPrincipal {
  kind: "agent";
  id: string;
  operatorId: string;
  payoutAddress: string;
  capabilities: { taskType: string; maxRows?: number }[];
}
export type Principal = UserPrincipal | AgentPrincipal;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export function newSessionToken(): string {
  return `afs_${randomBytes(32).toString("base64url")}`;
}

export function newAgentKey(): { key: string; prefix: string } {
  const prefix = randomBytes(4).toString("hex");
  return { key: `afk_${prefix}_${randomBytes(32).toString("base64url")}`, prefix };
}

export async function createSession(db: Db, userId: string, ttlHours: number) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await db.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)", [
    sha256(token),
    userId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function storeAgentKey(db: Db, agentId: string): Promise<string> {
  const { key, prefix } = newAgentKey();
  await db.query("insert into agent_keys (agent_id, key_hash, prefix) values ($1, $2, $3)", [
    agentId,
    sha256(key),
    prefix,
  ]);
  return key;
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

/** Resolves the caller, or null if no credentials were sent. Invalid credentials throw. */
export async function authenticate(db: Db, req: FastifyRequest): Promise<Principal | null> {
  const token = bearer(req);
  if (!token) return null;
  if (token.startsWith("afs_")) {
    const { rows } = await db.query<{ id: string; stellar_address: string }>(
      `select u.id, u.stellar_address from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) throw unauthorized("session expired or invalid");
    return { kind: "user", id: row.id, address: row.stellar_address };
  }
  if (token.startsWith("afk_")) {
    const { rows } = await db.query<{
      id: string;
      operator_id: string;
      payout_address: string;
      capabilities: AgentPrincipal["capabilities"];
    }>(
      `update agent_keys k set last_used_at = now()
       from agents a
       where k.key_hash = $1 and k.revoked_at is null and a.id = k.agent_id and a.status = 'active'
       returning a.id, a.operator_id, a.payout_address, a.capabilities`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) throw unauthorized("API key revoked or invalid");
    return {
      kind: "agent",
      id: row.id,
      operatorId: row.operator_id,
      payoutAddress: row.payout_address,
      capabilities: row.capabilities,
    };
  }
  throw unauthorized("unrecognized credentials");
}

export async function revokeSession(db: Db, req: FastifyRequest) {
  const token = bearer(req);
  if (token?.startsWith("afs_")) {
    await db.query("delete from sessions where token_hash = $1", [sha256(token)]);
  }
}
