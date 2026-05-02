/**
 * Leonardo.Ai API types — subset used by multix CLI.
 * Ported from leonardo-cli/src/api/types.ts.
 */

export interface CreateGenerationInput {
  prompt: string;
  modelId?: string;
  width?: number;
  height?: number;
  num_images?: number;
  alchemy?: boolean;
  ultra?: boolean;
  contrast?: number;
  styleUUID?: string;
  guidance_scale?: number;
  negative_prompt?: string;
  seed?: number;
  presetStyle?: string;
  enhancePrompt?: boolean;
  public?: boolean;
}

export interface CreateGenerationResponse {
  sdGenerationJob: {
    generationId: string;
    apiCreditCost?: number;
  };
}

export interface GenerationImage {
  id: string;
  url: string;
  nsfw?: boolean;
  likeCount?: number;
}

export interface Generation {
  id: string;
  status: "PENDING" | "COMPLETE" | "FAILED" | string;
  prompt?: string;
  modelId?: string;
  imageHeight?: number;
  imageWidth?: number;
  generated_images?: GenerationImage[];
}

export interface GetGenerationResponse {
  generations_by_pk: Generation | null;
}

export interface UserInfo {
  user_details: Array<{
    user: { id: string; username: string };
    subscriptionTokens: number;
    subscriptionGptTokens: number;
    subscriptionModelTokens: number;
    apiCredit?: number;
    apiPlanTokenRenewalDate?: string;
  }>;
}

export interface PlatformModel {
  id: string;
  name: string;
  description?: string;
  baseModel?: string;
}

export interface ListPlatformModelsResponse {
  custom_models: PlatformModel[];
}

export interface CreateVideoResponse {
  motionVideoGenerationJob?: { generationId: string; apiCreditCost?: number };
  [k: string]: unknown;
}

export interface CreateV2GenerationResponse {
  generate: { generationId: string };
}

export interface UpscaleResponse {
  universalUpscaler: { id: string; apiCreditCost?: number };
}

export interface UpscaleVariationStatus {
  generated_image_variation_generic: Array<{
    id: string;
    status: string;
    url?: string;
    transformType?: string;
  }>;
}
