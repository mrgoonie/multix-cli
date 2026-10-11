/**
 * Read an env-backed default at call time, so values from `.env` files loaded
 * by `loadEnv()` apply. Unset or blank values fall back to `fallback`.
 * Free of `node:*` imports so provider model modules can use it.
 */
export function envDefault(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}
