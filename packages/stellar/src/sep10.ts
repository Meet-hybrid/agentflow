/**
 * SEP-10 web authentication: the server issues a challenge transaction, the
 * user signs it with their wallet, and the server verifies the signature.
 * The server key here only signs challenges; it never holds funds.
 */
import { Keypair, WebAuth } from "@stellar/stellar-sdk";

export interface Sep10Config {
  serverSecret: string;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  timeoutSeconds?: number;
}

export function createChallenge(config: Sep10Config, account: string): string {
  return WebAuth.buildChallengeTx(
    Keypair.fromSecret(config.serverSecret),
    account,
    config.homeDomain,
    config.timeoutSeconds ?? 300,
    config.networkPassphrase,
    config.webAuthDomain,
  );
}

/**
 * Verifies a signed challenge and returns the authenticated account. Only the
 * account's master key is accepted (multisig accounts are not supported yet).
 */
export function verifyChallenge(config: Sep10Config, signedXdr: string): string {
  const serverAccount = Keypair.fromSecret(config.serverSecret).publicKey();
  const { clientAccountID } = WebAuth.readChallengeTx(
    signedXdr,
    serverAccount,
    config.networkPassphrase,
    config.homeDomain,
    config.webAuthDomain,
  );
  WebAuth.verifyChallengeTxSigners(
    signedXdr,
    serverAccount,
    config.networkPassphrase,
    [clientAccountID],
    config.homeDomain,
    config.webAuthDomain,
  );
  return clientAccountID;
}
