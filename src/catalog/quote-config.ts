/**
 * Parse the configuration to quote at from CLI flags or MCP/REST arguments,
 * one rule set for every surface. Fields left out are not assumed.
 */

import { TASKS, type Task, isTask } from "../capabilities/capability-types.js";
import { ValidationError } from "../core/errors.js";
import type { QuoteConfig } from "./catalog-types.js";

export interface ConfigFlags {
  task?: string;
  resolution?: string;
  duration?: string | number;
  aspectRatio?: string;
  audio?: string | boolean;
  count?: string | number;
}

export function taskOpt(value: string | undefined): Task | undefined {
  if (value === undefined) return undefined;
  if (!isTask(value)) {
    throw new ValidationError(`Unknown task "${value}". One of: ${TASKS.join(", ")}`);
  }
  return value;
}

function bounded(value: string | number | undefined, flag: string, max: number) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    throw new ValidationError(`${flag} must be a number above 0 and at most ${max}`);
  }
  return n;
}

const RESOLUTION = /^[0-9a-z]{2,12}$/i;
const ASPECT = /^\d{1,2}:\d{1,2}$/;

export function quoteConfig(f: ConfigFlags): QuoteConfig {
  const task = taskOpt(f.task);
  const duration = bounded(f.duration, "--duration", 3600);
  const count = bounded(f.count, "--count", 100);
  if (f.resolution !== undefined && !RESOLUTION.test(f.resolution)) {
    throw new ValidationError("--resolution looks like 720p, 1080p or 4k");
  }
  if (f.aspectRatio !== undefined && !ASPECT.test(f.aspectRatio)) {
    throw new ValidationError("--aspect-ratio looks like 16:9");
  }
  let audio: boolean | undefined;
  if (typeof f.audio === "boolean") audio = f.audio;
  else if (f.audio !== undefined) {
    const v = f.audio.toLowerCase();
    if (v !== "on" && v !== "off") throw new ValidationError("--audio must be on or off");
    audio = v === "on";
  }
  return {
    ...(task ? { task } : {}),
    ...(f.resolution ? { resolution: f.resolution.toLowerCase() } : {}),
    ...(duration !== undefined ? { duration_s: duration } : {}),
    ...(f.aspectRatio ? { aspect_ratio: f.aspectRatio } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}
