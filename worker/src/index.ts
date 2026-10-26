/**
 * multix remote MCP server for Cloudflare Workers, with OAuth and an account dashboard.
 *
 *   GET  /health                                    public, minimal: { ok: true }
 *   POST /mcp                                       MCP Streamable HTTP (2025 and 2026-07-28 with
 *                                                   MCP Events); OAuth access token required
 *   GET  /.well-known/oauth-protected-resource/mcp  RFC 9728 metadata (library)
 *   GET  /.well-known/oauth-authorization-server    RFC 8414 metadata (library)
 *   POST /oauth/register, /oauth/token              DCR and token endpoint (library)
 *   *    /oauth/authorize                           consent page (GitHub sign-in first)
 *   GET  /oauth/github/callback                     GitHub sign-in callback
 *   *    /dashboard[/…]                             account dashboard (provider keys, storage, API keys, clients)
 *   *    /api/v1/…                                  REST API; account API key required (api/api-router.ts)
 *                                                   (incl. /api/v1/events: job event webhooks, events/)
 *   GET  /api/docs                                  REST API reference (public)
 *
 * Each MCP request runs with the provider keys of the account that approved
 * the client, decrypted for that request only. The Worker itself never spawns
 * the CLI and never touches a file system: `multix_run` jobs run in a
 * per-job container owned by the MultixJobContainer Durable Object.
 */

import {
  OAuthProvider,
  type OAuthResourceAuth,
  insufficientScope,
} from "@cloudflare/workers-oauth-provider";
import { toolEnvFor } from "./accounts/account-store.js";
import { isAllowed } from "./accounts/allowlist.js";
import { API_PREFIX, handleApi } from "./api/api-router.js";
import { type AppDeps, ledgerFor, publicOrigin, resolveAppContext } from "./app-context.js";
import { type WorkerEnv, serverSettings } from "./config.js";
import { eventsContextFor } from "./events/events-context.js";
import { html, json, text } from "./http-responses.js";
import { jobsContextFor } from "./jobs/job-context.js";
import { handleMcpRequest } from "./mcp-api-handler.js";
import { apiDocsPage } from "./pages/api-docs-page.js";
import { logEvent } from "./redaction.js";
import { handleDashboard } from "./routes/dashboard-routes.js";
import { GITHUB_CALLBACK_PATH, finishGithubSignIn } from "./routes/github-sign-in-routes.js";
import {
  AUTHORIZE_PATH,
  type GrantProps,
  MCP_SCOPE,
  handleAuthorize,
} from "./routes/oauth-authorize-routes.js";

const API_DOCS_PATH = "/api/docs";

function notConfigured(): Response {
  logEvent("error", "server_not_configured", {});
  return text(503, "Service Unavailable");
}

/** The library validated the token; it leaves checking the token's scope to the handler. */
function tokenAuth(ctx: ExecutionContext): OAuthResourceAuth | undefined {
  return (ctx as ExecutionContext & { auth?: OAuthResourceAuth }).auth;
}

function grantProps(ctx: ExecutionContext): GrantProps | undefined {
  const props = (ctx as ExecutionContext & { props?: unknown }).props as
    | Partial<GrantProps>
    | undefined;
  return typeof props?.userId === "string" ? { userId: props.userId } : undefined;
}

/** /mcp with a valid token: load the account, enforce allowlist and rate limit, run the tools. */
async function handleAuthenticatedMcp(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  deps: AppDeps,
): Promise<Response> {
  const auth = tokenAuth(ctx);
  if (!auth?.scope.includes(MCP_SCOPE)) {
    return auth ? insufficientScope(auth, [MCP_SCOPE]) : text(401, "Unauthorized");
  }
  const app = await resolveAppContext(env, deps);
  if (!app) return notConfigured();
  const props = grantProps(ctx);
  const account = props ? await app.accounts.get(props.userId) : null;
  if (!account || !isAllowed(env.MULTIX_ALLOWED_USERS, account)) {
    return text(403, "Forbidden");
  }
  if (env.MCP_RATE_LIMITER) {
    const { success } = await env.MCP_RATE_LIMITER.limit({ key: account.id });
    if (!success) return text(429, "Too Many Requests", { "retry-after": "60" });
  }
  const keys = await app.accounts.providerKeys(account.id);
  const toolEnv = toolEnvFor(serverSettings(env), keys);
  const jobs = jobsContextFor(env, app, account.id, keys, deps, {
    source: "mcp",
    clientId: auth.clientId ?? null,
    clientName: null,
  });
  const events = eventsContextFor(env, app, deps, account.id, auth.clientId);
  const ledger = ledgerFor(env, deps, account.id);
  return handleMcpRequest(request, toolEnv, { jobs, events, ledger });
}

/** Everything that is not the protected /mcp resource or a library-owned OAuth endpoint. */
async function handleDefault(request: Request, env: WorkerEnv, deps: AppDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "Method Not Allowed", { allow: "GET, HEAD" });
    }
    return json(200, { ok: true });
  }
  const isDashboard = pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  const isApi = pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
  if (pathname === API_DOCS_PATH) {
    const origin = publicOrigin(env);
    if (!origin) return notConfigured();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "Method Not Allowed", { allow: "GET, HEAD" });
    }
    return html(200, apiDocsPage(origin));
  }
  if (pathname !== AUTHORIZE_PATH && pathname !== GITHUB_CALLBACK_PATH && !isDashboard && !isApi) {
    return text(404, "Not Found");
  }
  const app = await resolveAppContext(env, deps);
  if (!app) return notConfigured();
  if (isApi) return handleApi(app, deps, request);
  if (pathname === AUTHORIZE_PATH) return handleAuthorize(app, request);
  if (pathname === GITHUB_CALLBACK_PATH) {
    if (request.method !== "GET") return text(405, "Method Not Allowed", { allow: "GET" });
    return finishGithubSignIn(app, request);
  }
  return handleDashboard(app, request, deps);
}

function createOAuthProvider(origin: string, deps: AppDeps): OAuthProvider<WorkerEnv> {
  return new OAuthProvider<WorkerEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (request, env, ctx) => handleAuthenticatedMcp(request, env as WorkerEnv, ctx, deps),
    },
    defaultHandler: {
      fetch: (request, env) => handleDefault(request as Request, env as WorkerEnv, deps),
    },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [MCP_SCOPE],
    requiredScopes: [MCP_SCOPE],
    // URL client ids (MCP Client ID Metadata Documents); needs global_fetch_strictly_public.
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "multix MCP",
    },
  });
}

/**
 * Paths that start a sign-in, may fetch a client metadata document, or change
 * state; rate limited per IP when AUTH_RATE_LIMITER is bound.
 */
function isAuthRequest(request: Request, pathname: string): boolean {
  if (
    pathname === "/dashboard/login" ||
    pathname === GITHUB_CALLBACK_PATH ||
    pathname === AUTHORIZE_PATH
  ) {
    return true;
  }
  return (
    request.method === "POST" &&
    (pathname.startsWith("/oauth/") || pathname.startsWith("/dashboard"))
  );
}

export function createWorker(deps: AppDeps = {}): ExportedHandler<WorkerEnv> {
  const providers = new Map<string, OAuthProvider<WorkerEnv>>();
  return {
    async fetch(request, env, ctx) {
      const req = request as unknown as Request;
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return handleDefault(req, env, deps);
      const origin = publicOrigin(env);
      if (!origin || !env.OAUTH_KV) return notConfigured();

      if (env.AUTH_RATE_LIMITER && isAuthRequest(req, pathname)) {
        const key = req.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.AUTH_RATE_LIMITER.limit({ key });
        if (!success) return text(429, "Too Many Requests", { "retry-after": "60" });
      }

      let provider = providers.get(origin);
      if (!provider) {
        provider = createOAuthProvider(origin, deps);
        providers.set(origin, provider);
      }
      return provider.fetch(request, env, ctx);
    },
  };
}

export { AccountEvents } from "./events/account-events.js";
export { AccountJobQuota } from "./jobs/account-job-quota.js";
export { AccountLedger } from "./ledger/account-ledger.js";
export { MultixJobContainer } from "./jobs/multix-job-container.js";

export default createWorker();
