/** Minimal typed client for the AgentFlow API, with timeouts and retries. */

export class ApiRequestError extends Error {
  override name = "ApiRequestError";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ApiClient {
  private readonly opts: Required<ApiClientOptions>;

  constructor(opts: ApiClientOptions) {
    this.opts = { timeoutMs: 15_000, retries: 3, ...opts, baseUrl: opts.baseUrl.replace(/\/$/, "") };
  }

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        const res = await fetch(this.opts.baseUrl + path, {
          method,
          headers: {
            authorization: `Bearer ${this.opts.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : {};
        if (res.ok) return json as T;
        const err = new ApiRequestError(res.status, json.error?.code ?? "HTTP_ERROR", json.error?.message ?? text);
        // Retry only transient failures; 4xx responses are final.
        if (res.status < 500 && res.status !== 429) throw err;
        throw Object.assign(err, { retryable: true });
      } catch (e) {
        const retryable =
          (e as { retryable?: boolean }).retryable || (e as Error).name === "TimeoutError" || e instanceof TypeError;
        if (!retryable || attempt >= this.opts.retries) throw e;
        attempt++;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  get = <T = Record<string, unknown>>(path: string) => this.request<T>("GET", path);
  post = <T = Record<string, unknown>>(path: string, body: unknown = {}) => this.request<T>("POST", path, body);
}
