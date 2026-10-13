/**
 * Node stand-in for the `cloudflare:workers` module: only class identities
 * are used (workers-oauth-provider extends WorkerEntrypoint, and
 * @cloudflare/containers extends DurableObject when index.ts is imported).
 */
export class WorkerEntrypoint {}

export class DurableObject {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}
