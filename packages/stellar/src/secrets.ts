/**
 * Keys and signing without plaintext secrets in the repository or env files.
 *
 * - `cliSigner(alias)` signs with a Stellar CLI identity. With
 *   `stellar keys generate --secure-store` the key lives in the OS keyring and
 *   never leaves it: the CLI signs and returns the envelope.
 * - `keypairSigner(secret)` signs in memory (tests, ephemeral accounts).
 * - `resolveSecret(NAME)` reads a secret the process must hold itself (the
 *   SEP-10 challenge key) from NAME or a chmod-600 file at NAME_FILE.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

export interface Signer {
  readonly publicKey: string;
  /** Returns the transaction envelope with this signer's signature added. */
  sign(xdr: string, networkPassphrase: string): string;
}

export function keypairSigner(secret: string): Signer {
  const kp = Keypair.fromSecret(secret);
  return {
    publicKey: kp.publicKey(),
    sign(xdr, networkPassphrase) {
      const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      tx.sign(kp);
      return tx.toXdr();
    },
  };
}

const ALIAS = /^[A-Za-z0-9_-]+$/;

export function cliSigner(alias: string): Signer {
  if (!ALIAS.test(alias)) throw new Error(`invalid Stellar key alias ${alias}`);
  const publicKey = execFileSync("stellar", ["keys", "address", alias], { encoding: "utf8", timeout: 30_000 }).trim();
  return {
    publicKey,
    sign(xdr, networkPassphrase) {
      return execFileSync(
        "stellar",
        ["tx", "sign", "--sign-with-key", alias, "--network-passphrase", networkPassphrase, "--quiet"],
        { input: xdr, encoding: "utf8", timeout: 60_000 },
      ).trim();
    },
  };
}

export function resolveSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[name]) return env[name];
  const file = env[`${name}_FILE`];
  if (file) {
    if (statSync(file).mode & 0o077) throw new Error(`${file} must not be readable by group or others (chmod 600)`);
    return readFileSync(file, "utf8").trim();
  }
  return undefined;
}
