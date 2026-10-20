/** Fetch wrapper for the AgentFlow API. */
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8787";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let token: string | null = null;
export const setToken = (t: string | null) => {
  token = t;
};

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", `cannot reach the AgentFlow API at ${BASE}`);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json.error?.code ?? "HTTP",
      json.error?.message ?? res.statusText,
      json.error?.details,
    );
  }
  return json as T;
}

export interface Task {
  id: string;
  onchainId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  taskType: string;
  spec?: {
    csv: string;
    groupBy: string;
    metrics: { column: string; op: string }[];
    decimals: number;
  };
  specSha256: string;
  status: string;
  reward: { asset: string; assetContract: string; amount: string; baseUnits: string };
  deadline: string;
  constraints: { maxDurationSeconds: number };
  client: { id: string; address: string };
  assignedAgent: { id: string; name: string; payoutAddress: string } | null;
  rejections: number;
  reviewWindowSeconds: number | null;
  submittedAt: string | null;
  escrow: { contractId: string; network: string };
  createdAt: string;
  updatedAt: string;
}

export interface ChainOp {
  id: string;
  action: string;
  status: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "superseded";
  signer: string;
  txHash: string;
  xdr?: string;
  expiresAt: string;
  error: string | null;
}

export interface AppConfig {
  network: string;
  rpcUrl: string;
  escrowContractId: string;
  arbiter: string;
  assets: { code: string; contractId: string; decimals: number }[];
}
