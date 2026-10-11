/**
 * MCP tool surface. A fresh server is built per request (stateless
 * Streamable HTTP), so job state lives only at the provider and clients poll
 * by `provider` + `prediction_id`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import { PollTimeoutError } from "../../src/core/async-poll.js";
import { ConfigError, MultixError, ValidationError } from "../../src/core/errors.js";
import type { FetchLike } from "../../src/core/fetch-json.js";
import {
  DEFAULT_IMAGE_WAIT_SECONDS,
  type Env,
  MAX_IMAGE_WAIT_SECONDS,
  MAX_PROMPT_CHARS,
  csv,
  limitsFrom,
  secretValues,
} from "./config.js";
import {
  type JobResult,
  PROVIDERS,
  PROVIDER_IDS,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderId,
} from "./providers/index.js";
import { logEvent, sanitizeText } from "./redaction.js";
import { assertPublicHttpsUrl } from "./url-guard.js";

export const SERVER_NAME = "multix";

const IMAGE_PROVIDERS = ["replicate", "atlascloud"] as const;
const VIDEO_PROVIDERS = ["replicate", "atlascloud", "heygen", "cloudflare"] as const;
const CANCEL_PROVIDERS = ["replicate"] as const;

const modelSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/@-]+$/, "model must be a provider model id")
  .describe("Provider model id; omit for the provider default");
const promptSchema = z.string().trim().min(1).max(MAX_PROMPT_CHARS);
const aspectRatioSchema = z
  .string()
  .regex(/^\d{1,2}:\d{1,2}$/, "aspect_ratio must look like 16:9")
  .describe("Aspect ratio such as 1:1, 16:9 or 9:16 (model-dependent)");
const seedSchema = z.number().int().min(0).max(4_294_967_295);
const predictionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "prediction_id must be an opaque provider id");

export interface ServerDeps {
  /** Injected for tests; defaults to the Worker's fetch. */
  fetch?: FetchLike;
  version: string;
}

function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

class ToolInputError extends ValidationError {}

function allowedProviders(env: Env): Set<string> | undefined {
  const list = csv(env.MULTIX_MCP_ALLOWED_PROVIDERS);
  return list.length > 0 ? new Set(list) : undefined;
}

/** Resolve an adapter the caller may use: enabled by the allowlist and configured with a key. */
function usableProvider(env: Env, id: ProviderId): ProviderAdapter {
  const allowed = allowedProviders(env);
  if (allowed && !allowed.has(id)) {
    throw new ToolInputError(`Provider ${id} is not enabled on this server`);
  }
  const adapter = PROVIDERS[id];
  if (!adapter.isConfigured(env))
    throw new ConfigError(`Provider ${id} is not configured on this server`);
  return adapter;
}

function assertModelAllowed(env: Env, provider: ProviderId, model: string): void {
  const allowed = csv(env.MULTIX_MCP_ALLOWED_MODELS);
  if (allowed.length > 0 && !allowed.includes(`${provider}:${model}`)) {
    throw new ToolInputError(`Model ${model} is not enabled for ${provider} on this server`);
  }
}

function resolveModel(
  env: Env,
  adapter: ProviderAdapter,
  kind: "image" | "video",
  requested: string | undefined,
  hasImage = false,
): string {
  const model = requested ?? adapter.defaultModel(kind, { hasImage });
  if (!model) throw new ToolInputError(`Provider ${adapter.id} does not support ${kind} here`);
  assertModelAllowed(env, adapter.id, model);
  return model;
}

function jobPayload(job: JobResult, model?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...job };
  if (model) payload.model = model;
  if (!job.done) {
    payload.next = {
      tool: "multix_prediction_status",
      arguments: { provider: job.provider, prediction_id: job.id },
    };
  }
  return payload;
}

/**
 * Run a tool body, turning failures into MCP tool errors. Expected errors
 * (validation, config, provider, HTTP) keep their message after secret and
 * signed-URL scrubbing; anything else becomes a generic message.
 */
async function runTool(
  env: Env,
  tool: string,
  fields: Record<string, string | undefined>,
  body: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const payload = await body();
    logEvent("info", "tool_call", { tool, ...fields, ok: true, ms: Date.now() - started });
    return ok(payload);
  } catch (error) {
    const secrets = secretValues(env);
    const expected = error instanceof MultixError || error instanceof PollTimeoutError;
    const raw = error instanceof Error ? error.message : String(error);
    const message = sanitizeText(raw, secrets);
    logEvent(expected ? "warn" : "error", "tool_call", {
      tool,
      ...fields,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.name : "unknown",
      detail: message,
    });
    return toolError(expected ? message : "Internal error while running the tool");
  }
}

export function createMcpServer(env: Env, deps: ServerDeps): McpServer {
  const limits = limitsFrom(env);
  const ctx: ProviderContext = { env, limits, fetch: deps.fetch };
  const server = new McpServer(
    { name: SERVER_NAME, version: deps.version },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  server.registerTool(
    "multix_list_providers",
    {
      title: "List multix providers",
      description:
        "List the providers this server can use, with their capabilities, default models and limits. Never returns credentials.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      runTool(env, "multix_list_providers", {}, async () => {
        const allowed = allowedProviders(env);
        const providers = PROVIDER_IDS.map((id) => {
          const adapter = PROVIDERS[id];
          return {
            id,
            enabled: !allowed || allowed.has(id),
            configured: adapter.isConfigured(env),
            image: adapter.generateImage ? (adapter.defaultModel("image") ?? null) : null,
            video: adapter.generateVideo ? (adapter.defaultModel("video") ?? null) : null,
            cancel: Boolean(adapter.cancel),
          };
        });
        const models = csv(env.MULTIX_MCP_ALLOWED_MODELS);
        return {
          providers,
          allowed_models: models.length > 0 ? models : null,
          limits: {
            max_outputs: limits.maxOutputs,
            max_video_seconds: limits.maxVideoSeconds,
            max_prompt_chars: MAX_PROMPT_CHARS,
          },
        };
      }),
  );

  server.registerTool(
    "multix_generate_image",
    {
      title: "Generate image",
      description: `Generate images from a text prompt. Waits up to wait_seconds (max ${MAX_IMAGE_WAIT_SECONDS}) for the result; if it is not done yet, poll multix_prediction_status with the returned id. Returns output URLs.`,
      inputSchema: {
        provider: z.enum(IMAGE_PROVIDERS),
        model: modelSchema.optional(),
        prompt: promptSchema,
        negative_prompt: promptSchema.optional(),
        aspect_ratio: aspectRatioSchema.optional(),
        num_outputs: z.number().int().min(1).max(10).optional(),
        seed: seedSchema.optional(),
        wait_seconds: z.number().int().min(0).max(MAX_IMAGE_WAIT_SECONDS).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(
        env,
        "multix_generate_image",
        { provider: args.provider, model: args.model },
        async () => {
          if (args.num_outputs !== undefined && args.num_outputs > limits.maxOutputs) {
            throw new ToolInputError(`num_outputs must be at most ${limits.maxOutputs}`);
          }
          const adapter = usableProvider(env, args.provider);
          const model = resolveModel(env, adapter, "image", args.model);
          if (!adapter.generateImage) throw new ToolInputError("Image generation unsupported");
          const job = await adapter.generateImage(ctx, {
            model,
            prompt: args.prompt,
            negativePrompt: args.negative_prompt,
            aspectRatio: args.aspect_ratio,
            numOutputs: args.num_outputs,
            seed: args.seed,
            waitSeconds: args.wait_seconds ?? DEFAULT_IMAGE_WAIT_SECONDS,
          });
          return jobPayload(job, model);
        },
      ),
  );

  server.registerTool(
    "multix_generate_video",
    {
      title: "Generate video",
      description:
        "Start a text-to-video job (or image-to-video with image_url). Returns immediately with a prediction id; poll multix_prediction_status until done, then use the output URLs.",
      inputSchema: {
        provider: z.enum(VIDEO_PROVIDERS),
        model: modelSchema.optional(),
        prompt: promptSchema,
        image_url: z
          .string()
          .max(2048)
          .optional()
          .describe("Public https URL of a first-frame / reference image"),
        negative_prompt: promptSchema.optional(),
        aspect_ratio: aspectRatioSchema.optional(),
        resolution: z
          .string()
          .regex(/^(\d{3,4}p|2k|4k)$/i, "resolution must look like 720p")
          .optional(),
        duration: z.number().int().min(1).max(15).optional().describe("Seconds"),
        seed: seedSchema.optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(
        env,
        "multix_generate_video",
        { provider: args.provider, model: args.model },
        async () => {
          if (args.duration !== undefined && args.duration > limits.maxVideoSeconds) {
            throw new ToolInputError(`duration must be at most ${limits.maxVideoSeconds} seconds`);
          }
          const imageUrl =
            args.image_url === undefined
              ? undefined
              : assertPublicHttpsUrl(args.image_url, "image_url");
          const adapter = usableProvider(env, args.provider);
          const model = resolveModel(env, adapter, "video", args.model, imageUrl !== undefined);
          if (!adapter.generateVideo) throw new ToolInputError("Video generation unsupported");
          const job = await adapter.generateVideo(ctx, {
            model,
            prompt: args.prompt,
            negativePrompt: args.negative_prompt,
            aspectRatio: args.aspect_ratio,
            resolution: args.resolution,
            duration: args.duration,
            seed: args.seed,
            imageUrl,
          });
          return jobPayload(job, model);
        },
      ),
  );

  server.registerTool(
    "multix_prediction_status",
    {
      title: "Prediction status",
      description:
        "Read the status of an image or video job by provider and prediction id. When done and succeeded, outputs holds the result URLs.",
      inputSchema: { provider: z.enum(PROVIDER_IDS), prediction_id: predictionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(env, "multix_prediction_status", { provider: args.provider }, async () => {
        const adapter = usableProvider(env, args.provider);
        return jobPayload(await adapter.getStatus(ctx, args.prediction_id));
      }),
  );

  server.registerTool(
    "multix_prediction_cancel",
    {
      title: "Cancel prediction",
      description: "Cancel a running prediction. Only providers with a cancel API are accepted.",
      inputSchema: { provider: z.enum(CANCEL_PROVIDERS), prediction_id: predictionIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(env, "multix_prediction_cancel", { provider: args.provider }, async () => {
        const adapter = usableProvider(env, args.provider);
        if (!adapter.cancel) throw new ToolInputError(`Provider ${adapter.id} cannot cancel jobs`);
        return jobPayload(await adapter.cancel(ctx, args.prediction_id));
      }),
  );

  return server;
}
