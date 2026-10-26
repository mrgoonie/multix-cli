/**
 * Unique stamps for generated output file names.
 * A bare `Date.now()` collides when two processes (parallel agents, remote jobs)
 * write to the same output dir in the same millisecond, so a random suffix is added.
 * Runtime-neutral: uses the Web Crypto global, no `node:*` imports.
 */

/** Returns `<epoch-ms>-<8 hex chars>`, e.g. `1760955000000-3f9a1c07`. */
export function outputStamp(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${Date.now()}-${suffix}`;
}
