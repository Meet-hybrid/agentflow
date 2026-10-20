/** Errors that map to a specific HTTP status and stable error code. */
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

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "authentication required") =>
  new ApiError(401, "UNAUTHORIZED", message);
export const forbidden = (message: string) => new ApiError(403, "FORBIDDEN", message);
export const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);
export const unavailable = (message: string) => new ApiError(503, "CHAIN_UNAVAILABLE", message);
