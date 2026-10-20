import { EscrowClient } from "@agentflow/stellar";
import { type Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Config } from "./config.ts";
import type { ChainGateway } from "./services/chain.ts";

/** The network-backed ChainGateway used outside tests. */
export function stellarGateway(config: Config): ChainGateway & { client: EscrowClient } {
  const client = new EscrowClient({
    rpcUrl: config.STELLAR_RPC_URL,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    contractId: config.ESCROW_CONTRACT_ID,
  });
  return {
    client,
    prepare: (source, call) => client.prepare(source, call),
    readTask: (id) => client.readTask(id),
    outcome: (hash) => client.outcome(hash),
    async send(signedXdr) {
      const tx = TransactionBuilder.fromXDR(
        signedXdr,
        config.STELLAR_NETWORK_PASSPHRASE,
      ) as Transaction;
      const res = await client.send(tx);
      return {
        status: res.status,
        error: res.errorResult ? res.errorResult.result.type : undefined,
      };
    },
  };
}
