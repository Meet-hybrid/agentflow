/**
 * Drives an escrow transaction: prepare (API) → sign (wallet) → submit (API)
 * → wait for network confirmation. The UI shows each step; nothing is shown
 * as done until the chain confirms it.
 */
import { useCallback, useState } from "react";
import { api, type ChainOp } from "./api.ts";
import { useSession } from "./session.tsx";
import { signXdr } from "./wallet.ts";

export type Step =
  | "idle"
  | "preparing"
  | "signing"
  | "submitting"
  | "confirming"
  | "confirmed"
  | "failed";

export function useChainOp(taskId: string, onDone: () => void) {
  const { config, me } = useSession();
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [op, setOp] = useState<ChainOp | null>(null);

  const run = useCallback(
    async (request: Record<string, unknown>) => {
      if (!config || !me) return;
      setError(null);
      try {
        setStep("preparing");
        const prepared = await api<ChainOp>("POST", `/tasks/${taskId}/chain-ops`, request);
        setOp(prepared);
        setStep("signing");
        const signed = await signXdr(prepared.xdr as string, config.network, me.user.address);
        setStep("submitting");
        let current = await api<ChainOp>("POST", `/chain-ops/${prepared.id}/signed`, {
          signedXdr: signed,
        });
        setOp(current);
        setStep("confirming");
        const until = Date.now() + 180_000;
        while (current.status === "submitted" && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 2500));
          current = await api<ChainOp>("GET", `/chain-ops/${prepared.id}`);
          setOp(current);
        }
        if (current.status === "confirmed") {
          setStep("confirmed");
        } else {
          setStep("failed");
          setError(
            current.status === "submitted"
              ? "Still waiting for the network. The task will update when it confirms."
              : `Transaction ${current.status}${current.error ? `: ${current.error}` : ""}. No funds moved.`,
          );
        }
      } catch (e) {
        setStep("failed");
        setError((e as Error).message);
      } finally {
        onDone();
      }
    },
    [config, me, taskId, onDone],
  );

  return { run, step, error, op, busy: !["idle", "confirmed", "failed"].includes(step) };
}
