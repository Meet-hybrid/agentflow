/**
 * Decodes a prepared escrow transaction so a signer can check exactly what it
 * is about to authorize before signing. Agents refuse anything that is not a
 * single call to the expected escrow function for the expected task.
 */
import { Address, scValToNative, type Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { toJsonSafe } from "./escrow.ts";

export interface EscrowInvocation {
  source: string;
  fee: bigint;
  contractId: string;
  fn: string;
  args: unknown[];
}

export function inspectEscrowTx(xdr: string, networkPassphrase: string): EscrowInvocation {
  const parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  if ("innerTransaction" in parsed) throw new Error("fee-bump transactions are not accepted");
  const tx = parsed as Transaction;
  if (tx.operations.length !== 1)
    throw new Error(`expected 1 operation, found ${tx.operations.length}`);
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction") throw new Error(`unexpected operation ${op?.type}`);
  if (op.source && op.source !== tx.source)
    throw new Error("operation source differs from transaction source");
  if (op.func.type !== "hostFunctionTypeInvokeContract")
    throw new Error(`unexpected host function ${op.func.type}`);
  const call = op.func.invokeContract;
  return {
    source: tx.source,
    fee: BigInt(tx.fee),
    contractId: Address.fromScAddress(call.contractAddress).toString(),
    fn: call.functionName.toString(),
    args: call.args.map((a) => toJsonSafe(scValToNative(a))),
  };
}

export function assertEscrowTx(
  inv: EscrowInvocation,
  expected: { contractId: string; fn: string; taskId: string; source: string; maxFee: bigint },
) {
  const problems: string[] = [];
  if (inv.contractId !== expected.contractId)
    problems.push(`contract ${inv.contractId} is not the escrow`);
  if (inv.fn !== expected.fn) problems.push(`function ${inv.fn}, expected ${expected.fn}`);
  if (inv.args[0] !== expected.taskId) problems.push("task id does not match");
  if (inv.source !== expected.source)
    problems.push(`source ${inv.source} is not ${expected.source}`);
  if (inv.fee > expected.maxFee)
    problems.push(`fee ${inv.fee} exceeds the cap of ${expected.maxFee}`);
  if (problems.length) throw new Error(`refusing to sign: ${problems.join("; ")}`);
}
