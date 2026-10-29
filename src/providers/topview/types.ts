/**
 * TopView API types: the subset multix uses from the two separate TopView
 * surfaces. Runtime-neutral: no node:* imports, so the clients can be reused
 * outside Node (e.g. a Cloudflare Worker).
 *
 * - Legacy API (https://api.topview.ai, docs.topview.ai): marketing features,
 *   credits shared with the topview.ai web plan. Envelope
 *   `{ code: "200", message, result }` with a string code.
 * - API Platform (https://platform-backend.topview.ai, platform.topview.ai):
 *   generic video/image models, a separate USD balance per workspace.
 *   Envelope `{ code: 200, message, data }` with an integer code.
 */

/** Legacy task kinds that `topview status` can query. */
export type LegacyTaskKind =
  | "m2v"
  | "video-avatar"
  | "remove-bg"
  | "product-avatar-replace"
  | "product-avatar-video"
  | "anyshoot-try-on"
  | "anyshoot-background";

/** One downloadable result of a legacy task. */
export interface LegacyOutput {
  url: string;
  /** Short label for logs and file names (e.g. "export-12", "mask"). */
  label: string;
}

/** One m2v video entry (export or preview). */
export interface M2vVideo {
  type: "export" | "preview";
  scriptId?: number;
  status?: string;
  title?: string;
  videoUrl?: string;
  /** Milliseconds. */
  videoDuration?: number;
}

/** One product-avatar image_replace result (stage 2 output, stage 3 input). */
export interface ReplaceProductImage {
  imageId: string;
  fileId?: string;
  url?: string;
  faceExistence?: boolean;
}

/** A legacy task normalised across the per-feature query shapes. */
export interface LegacyTask {
  kind: LegacyTaskKind;
  taskId: string;
  /** init | running | success | fail; other values are kept and treated as not finished. */
  status: string;
  errorMsg?: string;
  /** Credits the task cost, when the query reports it (number or numeric string). */
  costCredit?: number;
  outputs: LegacyOutput[];
  /** m2v only: export and preview videos. */
  videos?: M2vVideo[];
  /** remove-bg only: file ids handed to the next stage. */
  bgRemovedImageFileId?: string;
  maskImageFileId?: string;
  /** product-avatar-replace only. */
  replaceResults?: ReplaceProductImage[];
}

/** Accepted legacy submission (`result` of a submit or export call). */
export interface LegacySubmitted {
  taskId: string;
  status?: string;
}

/** GET /user/credit/detail, reduced to what is safe to print (no API keys). */
export interface LegacyCreditDetail {
  remainCredit?: number;
  expiredTime?: string;
  recentTasks: Array<{
    taskId?: string;
    taskType?: string;
    costCredit?: number;
    date?: string;
  }>;
}

/** Platform prediction status. Unknown values are kept and treated as not finished. */
export type PlatformStatus =
  | "created"
  | "processing"
  | "payment_required"
  | "completed"
  | "failed"
  | (string & {});

/** Platform prediction (`data` of submit and poll responses). */
export interface PlatformPrediction {
  id: string;
  status: PlatformStatus;
  created_at?: string;
  /** 0 normal, 402 payment required, 1403 failed. */
  code?: number;
  outputs: string[];
  /** Exact decimal USD string as reported (e.g. "0.040000000000"). */
  charged_usd?: string;
  /** RESERVED (held, not final) | CAPTURED (settled) | RELEASED (refunded). */
  billing_state?: string;
  amount_due_usd?: string;
  additional_charge_usd?: string;
  shortfall_usd?: string;
  error?: string;
  last_frame_url?: string;
}

/** One price line of a public catalog offer, as the provider reports it. */
export interface PlatformOfferPrice {
  spec: Record<string, string | number | boolean>;
  componentCode?: string;
  meter?: string;
  unit?: string;
  unitSize?: string;
  saleUnitUsd?: string;
  referenceAsOf?: string;
}

/** One model of GET /platform/v1/models, reduced to what multix shows. */
export interface PlatformCatalogModel {
  displayName: string;
  category?: string;
  manufacturer?: string;
  offers: PlatformOfferPrice[];
}
