/**
 * Node stand-in for the `cloudflare:workers` module, aliased in at bundle
 * time (build-server.mjs). The Worker code only uses these classes as base
 * classes: DurableObject keeps `ctx` and `env`, and workers-oauth-provider
 * checks `instanceof WorkerEntrypoint` (a class no handler here extends).
 */

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {}
}

export class RpcTarget {}
