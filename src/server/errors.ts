export type AppErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION" | "CONFLICT" | "RATE_LIMITED";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

const HTTP: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
};

export function httpStatus(err: AppError): number {
  return HTTP[err.code];
}

/** Translate database errors to safe application errors (never leak SQL details to clients). */
export function fromDbError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const code = (err as { code?: string })?.code;
  if (code === "42501") return new AppError("FORBIDDEN", "You do not have permission to perform this action.");
  if (code === "23503") return new AppError("VALIDATION", "One of the selected options is not valid.");
  if (code === "23505") return new AppError("CONFLICT", "That record already exists.");
  if (code === "23514" || code === "22P02" || code === "23502")
    return new AppError("VALIDATION", "The submitted values are not allowed.");
  return new AppError("VALIDATION", "The request could not be completed.");
}
