/** Freighter wallet integration. The private key never leaves the wallet. */
import { getNetwork, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";

export class WalletError extends Error {}

export async function connectWallet(expectedNetwork: string): Promise<string> {
  const connected = await isConnected();
  if (connected.error || !connected.isConnected) {
    throw new WalletError(
      "Freighter is not installed. Install it from freighter.app and switch it to Testnet.",
    );
  }
  const access = await requestAccess();
  if (access.error) throw new WalletError(access.error.message ?? "wallet access was denied");
  await assertNetwork(expectedNetwork);
  return access.address;
}

async function assertNetwork(expected: string) {
  const net = await getNetwork();
  if (net.error) throw new WalletError(net.error.message ?? "cannot read the wallet network");
  if (net.networkPassphrase !== expected) {
    throw new WalletError(
      `Your wallet is on ${net.network}. Switch Freighter to the network this app uses (Testnet).`,
    );
  }
}

export async function signXdr(
  xdr: string,
  networkPassphrase: string,
  address: string,
): Promise<string> {
  await assertNetwork(networkPassphrase);
  const res = await signTransaction(xdr, { networkPassphrase, address });
  if (res.error)
    throw new WalletError(res.error.message ?? "the wallet did not sign the transaction");
  if (res.signerAddress && res.signerAddress !== address) {
    throw new WalletError(`signed with ${res.signerAddress}, expected ${address}`);
  }
  return res.signedTxXdr;
}
