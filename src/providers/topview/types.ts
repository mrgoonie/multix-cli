/**
 * TopView request and response types (runtime-neutral).
 * Response fields are parsed leniently: the legacy reference marks many of
 * them loosely, so every value is checked before use.
 */

import type { LegacyKind } from "./models.js";

/** Legacy envelope: `{ code: "200", message, result }` (code is a string in the docs). */
export interface LegacyEnvelope<T = unknown> {
  code?: string | number;
  message?: string;
  result?: T;
}

/** POST /v1/m2v/task/submit (URL-to-video and materials-to-video). */
export interface M2vSubmitRequest {
  productLink?: string;
  fileIds?: string[];
  productName?: string;
  productDescription?: string;
  aspectRatio?: string;
  language?: string;
  voiceId?: string;
  captionId?: string;
  aiavatarId?: string;
  videoLengthType?: number;
  endcardFileId?: string;
  endcardAspectRatio?: string;
  endcardBackgroundColor?: string;
  logoFileId?: string;
  musicFileId?: string;
  preview?: "true" | "false";
  isDiyScript?: "true" | "false";
  diyStyle?: "diyScriptStyle" | "diyScriptPrompt";
  diyScriptStyle?: string;
  diyScriptPrompt?: string;
  targetAudience?: string;
}

/** POST /v1/video_avatar/task/submit. */
export interface VideoAvatarSubmitRequest {
  avatarSourceFrom: "0" | "1" | "2" | "3";
  videoFileId?: string;
  imageFileId?: string;
  aiAvatarId?: string;
  isSave2CustomAiAvatar?: boolean;
  modeType?: "0" | "1";
  audioSourceFrom: "0" | "1";
  audioFileId?: string;
  ttsText?: string;
  voiceoverId?: string;
  voiceSpeed?: number;
  captionId?: string;
}

/** POST /v3/product_avatar/task/image_replace/submit. */
export interface ProductReplaceSubmitRequest {
  generateImageMode: "auto" | "manual";
  avatarId?: string;
  templateImageFileId?: string;
  productImageWithoutBackgroundFileId: string;
  imageEditPrompt?: string;
  location?: number[][];
}

/** POST /v3/product_avatar/task/image2Video/submit. */
export interface ProductImage2VideoSubmitRequest {
  replaceProductTaskImageId: string;
  mode: "avatar2" | "avatar4" | "avatar4Fast";
  scriptMode: "text" | "audio";
  ttsText?: string;
  voiceId?: string;
  audioFileId?: string;
  captionId?: string;
}

/** POST /v1/product_anyShoot/task/submit. */
export interface AnyshootSubmitRequest {
  productImageFileId: string;
  productMaskFileId?: string;
  templateId?: string;
  templateImageFileId?: string;
  templateMaskFileId: string;
  mode: "easy" | "advanced";
  easyModePrompt: string;
  generatingCount: string;
}

/** One m2v preview or export video. */
export interface M2vVideo {
  scriptId?: number | string;
  status: string;
  title?: string;
  videoUrl?: string;
  videoDuration?: number;
}

/** One product-avatar replacement image. */
export interface ReplaceImage {
  imageId?: string;
  fileId?: string;
  url?: string;
  faceExistence?: boolean;
}

/** A legacy task, normalized across kinds. */
export interface LegacyTask {
  kind: LegacyKind;
  taskId: string;
  /** Normalized: init | running | success | fail, or the raw value when unknown. */
  status: string;
  errorMsg?: string;
  /** Credits charged, when the query reports them. */
  costCredit?: number;
  /** Downloadable output URLs (signed; never print them in summaries). */
  outputs: string[];
  /** m2v only. */
  previewVideos?: M2vVideo[];
  exportVideos?: M2vVideo[];
  /** product-avatar-replace only. */
  images?: ReplaceImage[];
  /** remove-background only. */
  bgRemovedImageFileId?: string;
  maskImageFileId?: string;
}

/** POST /v1/m2v/task/submit and the other legacy submits. */
export interface LegacySubmitted {
  taskId: string;
  status: string;
}

export interface UploadTicket {
  fileId: string;
  uploadUrl: string;
}

/** GET /user/credit/detail, reduced to the fields multix shows (never apiKeyMap). */
export interface CreditDetail {
  remainCredit?: number;
  expiredTime?: string | number;
}

/** API Platform prediction statuses. */
export type PredictionStatus =
  | "created"
  | "processing"
  | "payment_required"
  | "completed"
  | "failed";

/** API Platform prediction (submit and poll share it). */
export interface Prediction {
  id: string;
  /** Normalized lower-case status; unknown values are kept as-is. */
  status: string;
  createdAt?: string;
  outputs: string[];
  /** Exact decimal string, e.g. "0.040000000000". */
  chargedUsd?: string;
  billingState?: string;
  error?: string;
  amountDueUsd?: string;
  additionalChargeUsd?: string;
  shortfallUsd?: string;
}

export interface MediaAsset {
  id: string;
  downloadUrl: string;
  reference?: string;
}
