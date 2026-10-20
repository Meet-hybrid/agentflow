import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Step } from "../useChainOp.ts";

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Always call the latest loader; reload when the caller's deps change.
  const loadRef = useRef(load);
  loadRef.current = load;
  const key = JSON.stringify(deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void key;
    void reload();
  }, [reload, key]);
  return { data, error, loading, reload };
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <p className="muted" role="status">
      {what}…
    </p>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="alert error" role="alert">
      {message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge s-${status}`}>{status.replace("_", " ")}</span>;
}

export const short = (s: string, n = 6) =>
  s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-n)}` : s;

export function explorer(kind: "tx" | "contract" | "account", id: string, network: string) {
  const net = network.includes("Test SDF")
    ? "testnet"
    : network.includes("Public")
      ? "public"
      : null;
  return net ? `https://stellar.expert/explorer/${net}/${kind}/${id}` : null;
}

export function ExplorerLink({
  kind,
  id,
  network,
}: {
  kind: "tx" | "contract" | "account";
  id: string;
  network: string;
}) {
  const href = explorer(kind, id, network);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="mono">
      {short(id, 8)}
    </a>
  ) : (
    <span className="mono">{short(id, 8)}</span>
  );
}

const STEP_TEXT: Record<Step, string> = {
  idle: "",
  preparing: "Preparing the transaction…",
  signing: "Approve the transaction in your wallet…",
  submitting: "Submitting to Stellar…",
  confirming: "Waiting for network confirmation…",
  confirmed: "Confirmed on Stellar.",
  failed: "",
};

export function TxProgress({
  step,
  error,
  txHash,
  network,
}: {
  step: Step;
  error: string | null;
  txHash?: string;
  network: string;
}) {
  if (step === "idle") return null;
  return (
    <div
      className={`alert ${step === "failed" ? "error" : step === "confirmed" ? "success" : "info"}`}
      role="status"
      aria-live="polite"
    >
      {step === "failed" ? error : STEP_TEXT[step]}
      {txHash && step !== "preparing" && step !== "signing" && (
        <>
          {" "}
          Transaction <ExplorerLink kind="tx" id={txHash} network={network} />
        </>
      )}
    </div>
  );
}

export const fmtDate = (iso: string) => new Date(iso).toLocaleString();
