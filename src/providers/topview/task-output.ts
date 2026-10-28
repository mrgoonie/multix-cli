/**
 * Where each TopView task reports its results (runtime-neutral). Only https
 * URLs are returned; anything else (such as raw Base64 image data) is counted
 * so the caller can say it was not saved.
 */

import type { LegacyTaskKind } from "./models.js";
import type { LegacyTask, PlatformPrediction } from "./types.js";

export interface TaskOutputs {
  urls: string[];
  /** Outputs that are not https URLs (never downloaded). */
  skipped: number;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
    : [];
}

function collect(values: unknown[]): TaskOutputs {
  const urls: string[] = [];
  let skipped = 0;
  for (const v of values) {
    if (typeof v === "string" && /^https:\/\//i.test(v.trim())) {
      if (!urls.includes(v.trim())) urls.push(v.trim());
    } else if (v !== undefined && v !== null && v !== "") {
      skipped++;
    }
  }
  return { urls, skipped };
}

/** Result URLs of a finished legacy task. */
export function legacyOutputs(kind: LegacyTaskKind, task: LegacyTask): TaskOutputs {
  switch (kind) {
    case "m2v": {
      // Exported videos are the result; previews exist only for preview submits.
      const found = collect(asRecords(task.exportVideos).map((v) => v.videoUrl));
      return found.urls.length > 0
        ? found
        : collect(asRecords(task.previewVideos).map((v) => v.videoUrl));
    }
    case "m2v-export":
      return collect(asRecords(task.exportVideos).map((v) => v.videoUrl));
    case "video-avatar":
      return collect([task.outputVideoUrl]);
    case "product-avatar-image":
      return collect(asRecords(task.replaceProductResult).map((r) => r.url));
    case "product-avatar-video":
      // The published schema spells this key with a trailing space.
      return collect([task.finishedVideoUrl ?? task["finishedVideoUrl "]]);
    case "anyshoot-model":
    case "anyshoot-background":
      return collect(asRecords(task.anyfitImages).map((r) => r.url));
  }
}

export function platformOutputs(prediction: PlatformPrediction): TaskOutputs {
  return collect(Array.isArray(prediction.outputs) ? prediction.outputs : []);
}

/** Credits a legacy task reports as consumed, when it reports a finite number. */
export function legacyCredits(task: LegacyTask): number | undefined {
  const value = task.costCredit;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The settled USD charge of a Platform task: `charged_usd` once billing_state
 * is CAPTURED (final) or RELEASED (hold returned). A RESERVED hold is not spend.
 */
export function platformChargedUsd(prediction: PlatformPrediction): number | undefined {
  if (prediction.billing_state !== "CAPTURED" && prediction.billing_state !== "RELEASED") {
    return undefined;
  }
  const raw = prediction.charged_usd;
  if (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw.trim())) return undefined;
  return Number(raw);
}
