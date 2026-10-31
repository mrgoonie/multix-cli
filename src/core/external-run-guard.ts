/**
 * Hook for paid work that does not go through fetch (a provider's own CLI,
 * such as the Codex image driver, or a WebSocket session). The CLI's agent runtime installs a guard
 * that ends a --dry-run before the program starts; without one this is a no-op.
 */

export interface ExternalRun {
  /** A program name, or a URL without credentials. */
  program: string;
  args: string[];
  /** Shown as the dry-run request method; defaults to EXEC. */
  method?: string;
}

let guard: ((run: ExternalRun) => void) | undefined;

export function setExternalRunGuard(fn: (run: ExternalRun) => void): void {
  guard = fn;
}

/** Call right before starting an external program that spends quota or credits. */
export function guardExternalRun(run: ExternalRun): void {
  guard?.(run);
}
