import { z } from "zod";

const assetSchema = z.object({
  code: z.string().min(1).max(12),
  contractId: z.string().regex(/^C[A-Z2-7]{55}$/),
  decimals: z.number().int().min(0).max(18),
});
export type AssetConfig = z.infer<typeof assetSchema>;

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().url(),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  STELLAR_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  STELLAR_NETWORK_PASSPHRASE: z.string().default("Test SDF Network ; September 2015"),
  ESCROW_CONTRACT_ID: z.string().regex(/^C[A-Z2-7]{55}$/),
  ARBITER_ADDRESS: z.string().regex(/^G[A-Z2-7]{55}$/),
  /** JSON array of {code, contractId, decimals}. */
  ASSETS: z.string().transform((s, ctx) => {
    try {
      return z.array(assetSchema).min(1).parse(JSON.parse(s));
    } catch (e) {
      ctx.addIssue({ code: "custom", message: `ASSETS: ${String(e)}` });
      return z.NEVER;
    }
  }),
  /** Signs SEP-10 challenges only. Never holds funds. */
  SEP10_SERVER_SECRET: z.string().regex(/^S[A-Z2-7]{55}$/),
  SEP10_HOME_DOMAIN: z.string().default("localhost"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration:\n${problems.join("\n")}`);
  }
  return parsed.data;
}
