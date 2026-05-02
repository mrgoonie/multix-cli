/**
 * Discriminated union Result type for all provider operations.
 * Avoids throwing across async boundaries for expected failures.
 */

export type OkResult<T> = { status: "success" } & T;
export type ErrResult = { status: "error"; error: string };
export type Result<T> = OkResult<T> | ErrResult;

/** Wrap a success payload into a Result. */
export function ok<T extends Record<string, unknown>>(data: T): OkResult<T> {
  return { status: "success", ...data };
}

/** Wrap an error message into a Result. */
export function err(message: string): ErrResult {
  return { status: "error", error: message };
}

/** Type guard: check if Result is success. */
export function isOk<T>(result: Result<T>): result is OkResult<T> {
  return result.status === "success";
}

/** Type guard: check if Result is error. */
export function isErr<T>(result: Result<T>): result is ErrResult {
  return result.status === "error";
}
