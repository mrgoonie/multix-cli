/** Gemini Interactions API adapter for preview Omni video operations. */

import { ProviderError } from "../../core/errors.js";
import { downloadFile, httpJson } from "../../core/http-client.js";
import { type FileRef, geminiAuthHeaders, requireGeminiApiKey } from "./client.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
export const OMNI_MODEL = "gemini-omni-flash-preview";

export type OmniInputPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string }
  | { type: "document"; uri: string };

export interface OmniInteractionRequest {
  prompt: string;
  images?: Array<{ data: string; mimeType: string }>;
  videoFileUri?: string;
  previousInteractionId?: string;
}

interface InteractionContent {
  type?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
}

export interface RawInteraction {
  id?: string;
  steps?: Array<{ type?: string; content?: InteractionContent[] }>;
}

export type OmniVideoOutput =
  | { kind: "inline"; data: string; mimeType: string }
  | { kind: "uri"; uri: string; mimeType: string };

export interface OmniInteractionResult {
  interactionId: string;
  video: OmniVideoOutput;
}

export function buildOmniInteractionPayload(
  request: OmniInteractionRequest,
): Record<string, unknown> {
  return {
    model: OMNI_MODEL,
    input: buildOmniInput(request),
    response_format: { type: "video", delivery: "uri" },
    store: true,
    ...(request.previousInteractionId
      ? { previous_interaction_id: request.previousInteractionId }
      : {}),
  };
}

export async function createOmniInteraction(
  request: OmniInteractionRequest,
): Promise<OmniInteractionResult> {
  const apiKey = requireGeminiApiKey();
  const raw = await httpJson<RawInteraction>({
    url: `${BASE}/interactions`,
    method: "POST",
    headers: geminiAuthHeaders(apiKey),
    body: buildOmniInteractionPayload(request),
  });

  if (!raw.id)
    throw new ProviderError("Omni response did not include an interaction ID.", "gemini");
  return { interactionId: raw.id, video: extractOmniVideo(raw) };
}

export function buildOmniInput(request: OmniInteractionRequest): OmniInputPart[] {
  const parts: OmniInputPart[] = [{ type: "text", text: request.prompt }];
  for (const image of request.images ?? []) {
    parts.push({ type: "image", data: image.data, mime_type: image.mimeType });
  }
  if (request.videoFileUri) parts.push({ type: "document", uri: request.videoFileUri });
  return parts;
}

export function extractOmniVideo(raw: RawInteraction): OmniVideoOutput {
  for (const step of raw.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const content of step.content ?? []) {
      if (content.type !== "video") continue;
      const mimeType = content.mime_type ?? "video/mp4";
      if (content.data) return { kind: "inline", data: content.data, mimeType };
      if (content.uri) return { kind: "uri", uri: content.uri, mimeType };
    }
  }
  throw new ProviderError("Omni response did not include a generated video.", "gemini");
}

export async function waitForGeminiFile(fileUri: string, timeoutMs = 300_000): Promise<FileRef> {
  const apiKey = requireGeminiApiKey();
  const name = fileNameFromUri(fileUri);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await httpJson<FileRef | { file: FileRef }>({
      url: `${BASE}/${name}`,
      headers: geminiAuthHeaders(apiKey),
    });
    const file = unwrapGeminiFile(response);
    if (file.state === "ACTIVE") return file;
    if (file.state === "FAILED") throw new ProviderError("Generated Omni video failed.", "gemini");
    await sleep(5_000);
  }

  throw new ProviderError("Timed out waiting for generated Omni video.", "gemini");
}

export async function downloadGeminiFile(fileUri: string, destination: string): Promise<void> {
  const apiKey = requireGeminiApiKey();
  await downloadFile(fileUri, destination, undefined, geminiAuthHeaders(apiKey));
}

export function fileNameFromUri(fileUri: string): string {
  const pathname = new URL(fileUri).pathname;
  const match = pathname.match(/\/(files\/[^/:]+)(?::download)?$/);
  if (!match?.[1]) throw new ProviderError(`Unexpected Gemini file URI: ${fileUri}`, "gemini");
  return match[1];
}

export function unwrapGeminiFile(response: FileRef | { file: FileRef }): FileRef {
  return "file" in response ? response.file : response;
}

export function selectGeminiDownloadUri(file: FileRef, fallbackUri: string): string {
  return file.downloadUri ?? fallbackUri;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
