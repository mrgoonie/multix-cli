/**
 * One thin adapter per provider for `multix generate`: map the shared request
 * onto the provider command that serves it (`fal video`, `atlas image-to-image`,
 * ...) as an argument list. The command then runs in-process with its own
 * validation, cost pre-flight, polling, downloads and result envelope, so
 * nothing about a provider is implemented twice.
 *
 * An adapter refuses, with a ConfigError and before any request, every input
 * its command cannot take, rather than dropping it.
 */

import type { Task } from "../../capabilities/capability-types.js";
import { ConfigError } from "../../core/errors.js";
import {
  DEFAULT_BYTEPLUS_IMAGE_MODEL,
  DEFAULT_BYTEPLUS_VIDEO_MODEL,
} from "../../providers/byteplus/models.js";
import {
  CLOUDFLARE_IMAGE_MODEL,
  CLOUDFLARE_VIDEO_MODEL,
} from "../../providers/cloudflare/model-ids.js";
import {
  GEMINI_IMAGE_MODELS,
  GEMINI_OMNI_MODEL_DEFAULT,
  IMAGE_MODEL_DEFAULT,
} from "../../providers/gemini/models.js";
import { HEYGEN_VIDEO_MODEL } from "../../providers/heygen/models.js";
import {
  DEFAULT_LEONARDO_MODEL_ID,
  LEONARDO_VIDEO_MODELS,
} from "../../providers/leonardo/models.js";
import { MINIMAX_IMAGE_MODELS, MINIMAX_VIDEO_MODELS } from "../../providers/minimax/models.js";
import { DEFAULT_OPENAI_IMAGE_MODEL } from "../../providers/openai/models.js";
import {
  IMAGE_MODELS as RUNWAY_IMAGE_MODELS,
  VIDEO_MODELS as RUNWAY_VIDEO_MODELS,
} from "../../providers/runway/models.js";
import { PLATFORM_ROUTES } from "../../providers/topview/models.js";

export const GENERATE_TASKS = ["image", "video", "lipsync", "upscale"] as const;
export type GenerateTask = (typeof GENERATE_TASKS)[number];

export function isGenerateTask(value: string): value is GenerateTask {
  return (GENERATE_TASKS as readonly string[]).includes(value);
}

/** The finer capability tasks each generate task covers (`models --task` names). */
export const GENERATE_TASK_VARIANTS: Readonly<Record<GenerateTask, readonly Task[]>> = {
  image: ["image", "image-edit"],
  video: ["video", "image-to-video"],
  lipsync: ["lipsync"],
  upscale: ["upscale"],
};

export interface GenerateInput {
  task: GenerateTask;
  prompt?: string;
  model?: string;
  images: string[];
  endImage?: string;
  video?: string;
  audio?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  numImages?: string;
  generateAudio?: boolean;
  output?: string;
  async: boolean;
  /** Milliseconds; set from --wait-timeout or MULTIX_WAIT_TIMEOUT. */
  waitTimeout?: string;
  /** The wait timeout came from MULTIX_WAIT_TIMEOUT: a default, never refused. */
  waitTimeoutFromEnv?: boolean;
}

export interface GeneratePlan {
  /** Provider command that runs, e.g. "fal video". */
  command: string;
  /** Its positional arguments and options. */
  args: string[];
  /** Capability task of this request, e.g. "image-to-video". */
  variant: Task;
  /** False when the command has no --output; generate copies its single output there. */
  writesOutput: boolean;
}

/** A model a provider can run for a task. */
export interface ModelEntry {
  id: string;
  label?: string;
  tasks: Task[];
}

export interface GenerateAdapter {
  /** Capability tasks served, per generate task (absent: the provider cannot do it). */
  serves: Partial<Record<GenerateTask, readonly Task[]>>;
  /** Model used when --model is omitted (env overrides applied by the command). */
  defaultModel?: (task: GenerateTask) => string | undefined;
  /** True when the command passes any provider model id through. */
  anyModel?: (task: GenerateTask) => boolean;
  /** Models multix knows offline; the live list (generate-models.ts) adds the rest. */
  staticModels: (task: GenerateTask) => ModelEntry[];
  /** Throws ConfigError for input the command cannot take; sends nothing. */
  plan: (input: GenerateInput) => GeneratePlan;
}

type Field =
  | "prompt"
  | "model"
  | "images"
  | "endImage"
  | "video"
  | "audio"
  | "aspectRatio"
  | "resolution"
  | "duration"
  | "numImages"
  | "generateAudio"
  | "output"
  | "async"
  | "waitTimeout";

const FLAG: Record<Field, string> = {
  prompt: "a prompt",
  model: "--model",
  images: "--image",
  endImage: "--end-image",
  video: "--video",
  audio: "--audio",
  aspectRatio: "--aspect-ratio",
  resolution: "--resolution",
  duration: "--duration",
  numImages: "--num-images",
  generateAudio: "--generate-audio/--no-generate-audio",
  output: "--output",
  async: "--async",
  waitTimeout: "--wait-timeout",
};

function given(input: GenerateInput): Field[] {
  const fields: Field[] = [];
  const set = (f: Field, v: unknown) => {
    if (v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0)) fields.push(f);
  };
  set("prompt", input.prompt);
  set("model", input.model);
  set("images", input.images);
  set("endImage", input.endImage);
  set("video", input.video);
  set("audio", input.audio);
  set("aspectRatio", input.aspectRatio);
  set("resolution", input.resolution);
  set("duration", input.duration);
  set("numImages", input.numImages);
  set("generateAudio", input.generateAudio);
  set("output", input.output);
  set("async", input.async);
  set("waitTimeout", input.waitTimeout);
  return fields;
}

/**
 * Refuse every given input `command` cannot take. The wait timeout is only
 * refused when the user set it on the command line; MULTIX_WAIT_TIMEOUT is a
 * default for the commands that have one.
 */
function accept(
  input: GenerateInput,
  label: string,
  allowed: readonly Field[],
  waitTimeoutFromEnv: boolean,
): void {
  const refused = given(input).filter(
    (f) => !allowed.includes(f) && !(f === "waitTimeout" && waitTimeoutFromEnv),
  );
  if (refused.length > 0) {
    throw new ConfigError(
      `${label} does not take ${refused.map((f) => FLAG[f]).join(", ")}. Remove ${refused.length > 1 ? "them" : "it"}, or pick another provider (multix models --task ${input.task} --live)`,
    );
  }
}

/** Mutable argument builder for one plan. */
class Args {
  readonly list: string[] = [];
  pos(value: string | undefined): this {
    if (value !== undefined) this.list.push(value);
    return this;
  }
  opt(flag: string, value: string | undefined): this {
    if (value !== undefined) this.list.push(flag, value);
    return this;
  }
  bool(flag: string, on: boolean | undefined): this {
    if (on) this.list.push(flag);
    return this;
  }
  each(flag: string, values: readonly string[]): this {
    for (const v of values) this.list.push(flag, v);
    return this;
  }
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUrls(label: string, flag: string, values: readonly (string | undefined)[]): void {
  const bad = values.filter((v): v is string => v !== undefined && !isUrl(v));
  if (bad.length > 0) {
    throw new ConfigError(
      `${label} takes ${flag} only as an http(s) URL; upload local files first or pick another provider`,
    );
  }
}

function atMost(label: string, flag: string, values: readonly string[], max: number): void {
  if (values.length > max) {
    throw new ConfigError(`${label} takes at most ${max} ${flag}`);
  }
}

function needs(label: string, ok: boolean, what: string): void {
  if (!ok) throw new ConfigError(`${label} needs ${what}`);
}

function check(input: GenerateInput, label: string, allowed: readonly Field[]): Args {
  accept(input, label, allowed, input.waitTimeoutFromEnv === true);
  return new Args();
}

/** --wait-timeout for a command that has one. */
function timeout(a: Args, input: GenerateInput): Args {
  return a.opt("--wait-timeout", input.waitTimeout);
}

/**
 * Commands that only return a job id unless told to wait: wait (and download)
 * by default, return the id with --async.
 */
function waitUnlessAsync(a: Args, input: GenerateInput, flag: "--wait" | "--download"): Args {
  if (!input.async) a.bool(flag, true);
  return timeout(a, input);
}

const ids = (list: Iterable<string>, tasks: Task[]): ModelEntry[] =>
  [...list].map((id) => ({ id, tasks }));

const BASE: Field[] = ["prompt", "model", "output"];

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const gemini: GenerateAdapter = {
  serves: { image: ["image", "image-edit"], video: ["video", "image-to-video"] },
  defaultModel: (task) => (task === "image" ? IMAGE_MODEL_DEFAULT : GEMINI_OMNI_MODEL_DEFAULT),
  staticModels: (task) =>
    task === "image"
      ? ids(GEMINI_IMAGE_MODELS, ["image", "image-edit"])
      : [
          {
            id: GEMINI_OMNI_MODEL_DEFAULT,
            label: "Gemini Omni Flash",
            tasks: ["video", "image-to-video"],
          },
        ],
  plan(input) {
    if (input.task === "image") {
      if (input.images.length === 0) {
        const a = check(input, "gemini image", [...BASE, "aspectRatio", "numImages", "resolution"]);
        a.opt("--prompt", input.prompt).opt("--model", input.model);
        a.opt("--aspect-ratio", input.aspectRatio).opt("--num-images", input.numImages);
        a.opt("--size", input.resolution?.toUpperCase()).opt("--output", input.output);
        return { command: "gemini generate", args: a.list, variant: "image", writesOutput: true };
      }
      const a = check(input, "gemini image edit", [...BASE, "images"]);
      a.opt("--prompt", input.prompt).each("--ref", input.images).opt("--model", input.model);
      a.opt("--output", input.output);
      return {
        command: "gemini image-to-image",
        args: a.list,
        variant: "image-edit",
        writesOutput: true,
      };
    }
    const video: Field[] = [
      ...BASE,
      "aspectRatio",
      "resolution",
      "duration",
      "async",
      "waitTimeout",
    ];
    const finish = (a: Args) => {
      a.opt("--prompt", input.prompt).opt("--model", input.model);
      a.opt("--resolution", input.resolution).opt("--aspect-ratio", input.aspectRatio);
      a.opt("--duration", input.duration).bool("--no-wait", input.async);
      timeout(a, input).opt("--output", input.output);
      return a.list;
    };
    const [first, ...rest] = input.images;
    if (first !== undefined && (rest.length === 0 || input.endImage !== undefined)) {
      const a = check(input, "gemini image-to-video", [...video, "images", "endImage"]);
      atMost(
        "gemini image-to-video",
        "--image (use --end-image for the closing frame)",
        input.images,
        1,
      );
      a.pos(first).opt("--last-frame", input.endImage);
      return {
        command: "gemini image-to-video",
        args: finish(a),
        variant: "image-to-video",
        writesOutput: true,
      };
    }
    const a = check(input, "gemini video", [...video, "images"]);
    if (input.images.length > 0) a.list.push("--reference-images", ...input.images);
    return {
      command: "gemini generate-video",
      args: finish(a),
      variant: input.images.length > 0 ? "image-to-video" : "video",
      writesOutput: true,
    };
  },
};

const minimax: GenerateAdapter = {
  serves: { image: ["image", "image-edit"], video: ["video", "image-to-video"] },
  defaultModel: (task) => (task === "image" ? "image-01" : "MiniMax-Hailuo-2.3"),
  staticModels: (task) =>
    task === "image"
      ? ids(MINIMAX_IMAGE_MODELS, ["image", "image-edit"])
      : ids(MINIMAX_VIDEO_MODELS, ["video", "image-to-video"]),
  plan(input) {
    if (input.task === "image") {
      const edit = input.images.length > 0;
      const label = edit ? "minimax image-to-image (subject reference)" : "minimax image";
      const a = check(input, label, [
        ...BASE,
        "aspectRatio",
        "numImages",
        ...(edit ? (["images"] as Field[]) : []),
      ]);
      atMost(label, "--image", input.images, 1);
      a.opt("--prompt", input.prompt).opt("--ref", input.images[0]).opt("--model", input.model);
      a.opt("--aspect-ratio", input.aspectRatio).opt("--num-images", input.numImages);
      a.opt("--output", input.output);
      return edit
        ? {
            command: "minimax image-to-image",
            args: a.list,
            variant: "image-edit",
            writesOutput: true,
          }
        : { command: "minimax generate", args: a.list, variant: "image", writesOutput: true };
    }
    const label = "minimax video";
    const a = check(input, label, [...BASE, "images", "duration", "resolution"]);
    atMost(label, "--image", input.images, 1);
    requireUrls(label, "--image", input.images);
    a.opt("--prompt", input.prompt).opt("--model", input.model);
    a.opt("--first-frame", input.images[0]).opt("--duration", input.duration);
    a.opt("--resolution", input.resolution?.toUpperCase()).opt("--output", input.output);
    return {
      command: "minimax generate-video",
      args: a.list,
      variant: input.images.length ? "image-to-video" : "video",
      writesOutput: true,
    };
  },
};

/** OpenAI image sizes by aspect ratio. */
const OPENAI_SIZES: Readonly<Record<string, string>> = {
  "1:1": "1024x1024",
  "2:3": "1024x1536",
  "3:2": "1536x1024",
};

function openaiSize(aspect: string | undefined): string | undefined {
  if (aspect === undefined) return undefined;
  const size = OPENAI_SIZES[aspect];
  if (!size) {
    throw new ConfigError(
      `openai image takes --aspect-ratio ${Object.keys(OPENAI_SIZES).join(", ")} only`,
    );
  }
  return size;
}

const openai: GenerateAdapter = {
  serves: { image: ["image", "image-edit"] },
  defaultModel: () => DEFAULT_OPENAI_IMAGE_MODEL,
  staticModels: () => [{ id: DEFAULT_OPENAI_IMAGE_MODEL, tasks: ["image", "image-edit"] }],
  plan(input) {
    if (input.task !== "image") throw unsupported("openai", input.task);
    const edit = input.images.length > 0;
    const a = edit
      ? check(input, "openai image edit", [...BASE, "images", "aspectRatio"])
      : check(input, "openai image", [...BASE, "aspectRatio", "numImages"]);
    a.opt("--prompt", input.prompt).each("--ref", input.images).opt("--model", input.model);
    a.opt("--size", openaiSize(input.aspectRatio)).opt("--num-images", input.numImages);
    a.opt("--output", input.output);
    return edit
      ? {
          command: "openai image-to-image",
          args: a.list,
          variant: "image-edit",
          writesOutput: true,
        }
      : { command: "openai generate", args: a.list, variant: "image", writesOutput: true };
  },
};

const openrouter: GenerateAdapter = {
  serves: { image: ["image", "image-edit"], video: ["image-to-video"] },
  anyModel: () => true,
  defaultModel: (task) => (task === "image" ? "google/gemini-2.5-flash-image" : undefined),
  staticModels: (task) =>
    task === "image"
      ? [{ id: "google/gemini-2.5-flash-image", tasks: ["image", "image-edit"] }]
      : [{ id: "google/veo-3.1", tasks: ["image-to-video"] }],
  plan(input) {
    if (input.task === "image") {
      if (input.images.length === 0) {
        const a = check(input, "openrouter image", [
          ...BASE,
          "aspectRatio",
          "resolution",
          "numImages",
        ]);
        a.opt("--prompt", input.prompt).opt("--model", input.model);
        a.opt("--aspect-ratio", input.aspectRatio).opt("--image-size", input.resolution);
        a.opt("--num-images", input.numImages).opt("--output", input.output);
        return {
          command: "openrouter generate",
          args: a.list,
          variant: "image",
          writesOutput: true,
        };
      }
      const a = check(input, "openrouter image edit", [...BASE, "images"]);
      a.opt("--prompt", input.prompt).each("--ref", input.images).opt("--model", input.model);
      a.opt("--output", input.output);
      return {
        command: "openrouter image-to-image",
        args: a.list,
        variant: "image-edit",
        writesOutput: true,
      };
    }
    if (input.task !== "video") throw unsupported("openrouter", input.task);
    const label = "openrouter video (image-to-video only)";
    const a = check(input, label, [
      ...BASE,
      "images",
      "endImage",
      "resolution",
      "aspectRatio",
      "duration",
      "async",
      "waitTimeout",
    ]);
    needs(label, input.images.length === 1, "exactly one --image (the first frame)");
    requireUrls(label, "--image/--end-image", [...input.images, input.endImage]);
    a.opt("--prompt", input.prompt).opt("--image-url", input.images[0]);
    a.opt("--last-frame-url", input.endImage).opt("--model", input.model);
    a.opt("--resolution", input.resolution).opt("--aspect-ratio", input.aspectRatio);
    a.opt("--duration", input.duration);
    waitUnlessAsync(a, input, "--download").opt("--output", input.output);
    return {
      command: "openrouter image-to-video",
      args: a.list,
      variant: "image-to-video",
      writesOutput: true,
    };
  },
};

const LEONARDO_RESOLUTIONS: Readonly<Record<string, string>> = {
  "480p": "RESOLUTION_480",
  "720p": "RESOLUTION_720",
  "1080p": "RESOLUTION_1080",
};

function leonardoResolution(value: string | undefined): string | undefined {
  if (value === undefined || /^RESOLUTION_/.test(value)) return value;
  const mapped = LEONARDO_RESOLUTIONS[value.toLowerCase()];
  if (!mapped) throw new ConfigError("leonardo video takes --resolution 480p, 720p or 1080p");
  return mapped;
}

function leonardoImageId(label: string, images: readonly string[]): string {
  const [id] = images;
  if (images.length !== 1 || id === undefined || !UUID.test(id)) {
    throw new ConfigError(
      `${label} takes one --image that is a Leonardo image id (UUID) from an earlier Leonardo generation, not a file or URL`,
    );
  }
  return id;
}

/** Name for Leonardo's one upscaler (it takes no model id). */
const LEONARDO_UPSCALER = "universal-upscaler";

const leonardo: GenerateAdapter = {
  serves: {
    image: ["image", "image-edit"],
    video: ["video", "image-to-video"],
    upscale: ["upscale"],
  },
  defaultModel: (task) =>
    task === "video" ? "MOTION2" : task === "image" ? DEFAULT_LEONARDO_MODEL_ID : LEONARDO_UPSCALER,
  staticModels: (task) =>
    task === "video"
      ? LEONARDO_VIDEO_MODELS.map((m) => ({
          id: m.id,
          label: m.name,
          tasks: (m.modes as readonly string[]).includes("i2v")
            ? ["video", "image-to-video"]
            : ["video"],
        }))
      : task === "upscale"
        ? [{ id: LEONARDO_UPSCALER, label: "Universal Upscaler", tasks: ["upscale"] }]
        : [{ id: DEFAULT_LEONARDO_MODEL_ID, tasks: ["image", "image-edit"] }],
  plan(input) {
    if (input.task === "image") {
      if (input.images.length === 0) {
        const a = check(input, "leonardo image", [...BASE, "numImages", "waitTimeout"]);
        a.pos(input.prompt).opt("--model", input.model).opt("--num", input.numImages);
        timeout(a, input).opt("--output", input.output);
        return { command: "leonardo generate", args: a.list, variant: "image", writesOutput: true };
      }
      const label = "leonardo image edit";
      const a = check(input, label, [...BASE, "images", "numImages", "waitTimeout"]);
      a.opt("--prompt", input.prompt).opt("--ref", leonardoImageId(label, input.images));
      a.opt("--model", input.model).opt("--num", input.numImages);
      timeout(a, input).opt("--output", input.output);
      return {
        command: "leonardo image-to-image",
        args: a.list,
        variant: "image-edit",
        writesOutput: true,
      };
    }
    if (input.task === "upscale") {
      const label = "leonardo upscale";
      const a = check(input, label, ["model", "images", "output"]);
      fixedModel(label, input.model, LEONARDO_UPSCALER);
      a.pos(leonardoImageId(label, input.images));
      return { command: "leonardo upscale", args: a.list, variant: "upscale", writesOutput: false };
    }
    if (input.task !== "video") throw unsupported("leonardo", input.task);
    const fields: Field[] = [...BASE, "resolution", "async", "waitTimeout"];
    if (input.images.length === 0) {
      const a = check(input, "leonardo video", fields);
      a.pos(input.prompt).opt("--model", input.model);
      a.opt("--resolution", leonardoResolution(input.resolution));
      waitUnlessAsync(a, input, "--download").opt("--output", input.output);
      return { command: "leonardo video", args: a.list, variant: "video", writesOutput: true };
    }
    const label = "leonardo image-to-video";
    const a = check(input, label, [...fields, "images", "duration"]);
    a.pos(leonardoImageId(label, input.images)).opt("--prompt", input.prompt);
    a.opt("--model", input.model).opt("--resolution", leonardoResolution(input.resolution));
    a.opt("--duration", input.duration);
    waitUnlessAsync(a, input, "--download").opt("--output", input.output);
    return {
      command: "leonardo image-to-video",
      args: a.list,
      variant: "image-to-video",
      writesOutput: true,
    };
  },
};

const byteplus: GenerateAdapter = {
  serves: { image: ["image", "image-edit"], video: ["video", "image-to-video"] },
  defaultModel: (task) =>
    task === "image" ? DEFAULT_BYTEPLUS_IMAGE_MODEL : DEFAULT_BYTEPLUS_VIDEO_MODEL,
  staticModels: (task) =>
    task === "image"
      ? [
          {
            id: DEFAULT_BYTEPLUS_IMAGE_MODEL,
            label: "Seedream 4.0",
            tasks: ["image", "image-edit"],
          },
        ]
      : [
          {
            id: "seedance-2.0-fast",
            label: "Seedance 2.0 Fast",
            tasks: ["video", "image-to-video"],
          },
          { id: "seedance-2.0", label: "Seedance 2.0", tasks: ["video", "image-to-video"] },
          { id: "seedance-2.0-pro", label: "Seedance 2.0 Pro", tasks: ["video", "image-to-video"] },
        ],
  plan(input) {
    if (input.task === "image") {
      const edit = input.images.length > 0;
      const a = check(input, edit ? "byteplus image edit" : "byteplus image", [
        ...BASE,
        "aspectRatio",
        "resolution",
        "numImages",
        ...(edit ? (["images"] as Field[]) : []),
      ]);
      a.opt("--prompt", input.prompt).each("--ref", input.images).opt("--model", input.model);
      a.opt("--size", input.resolution).opt("--aspect-ratio", input.aspectRatio);
      a.opt("--num-images", input.numImages).opt("--output", input.output);
      return edit
        ? {
            command: "byteplus image-to-image",
            args: a.list,
            variant: "image-edit",
            writesOutput: true,
          }
        : { command: "byteplus generate", args: a.list, variant: "image", writesOutput: true };
    }
    if (input.task !== "video") throw unsupported("byteplus", input.task);
    const fields: Field[] = [
      ...BASE,
      "resolution",
      "duration",
      "aspectRatio",
      "generateAudio",
      "async",
      "waitTimeout",
    ];
    const finish = (a: Args) => {
      a.opt("--prompt", input.prompt).opt("--model", input.model);
      a.opt("--resolution", input.resolution).opt("--duration", input.duration);
      a.opt("--aspect-ratio", input.aspectRatio);
      if (input.generateAudio !== undefined)
        a.bool(input.generateAudio ? "--audio" : "--no-audio", true);
      a.bool("--async", input.async);
      timeout(a, input).opt("--output", input.output);
      return a.list;
    };
    if (input.images.length === 0) {
      const a = check(input, "byteplus video", fields);
      return { command: "byteplus video", args: finish(a), variant: "video", writesOutput: true };
    }
    const label = "byteplus image-to-video";
    const a = check(input, label, [...fields, "images", "endImage"]);
    atMost(label, "--image (use --end-image for the last frame)", input.images, 1);
    a.pos(input.images[0]).opt("--last-frame", input.endImage);
    return {
      command: "byteplus image-to-video",
      args: finish(a),
      variant: "image-to-video",
      writesOutput: true,
    };
  },
};

function fixedModel(label: string, model: string | undefined, only: string): void {
  if (model !== undefined && model !== only) {
    throw new ConfigError(`${label} runs only ${only}; got --model ${model}`);
  }
}

const cloudflare: GenerateAdapter = {
  serves: { image: ["image"], video: ["video"] },
  defaultModel: (task) => (task === "image" ? CLOUDFLARE_IMAGE_MODEL : CLOUDFLARE_VIDEO_MODEL),
  staticModels: (task) => [
    task === "image"
      ? { id: CLOUDFLARE_IMAGE_MODEL, label: "FLUX.1 [schnell]", tasks: ["image"] }
      : { id: CLOUDFLARE_VIDEO_MODEL, label: "P-Video (AI Gateway)", tasks: ["video"] },
  ],
  plan(input) {
    if (input.task === "image") {
      const a = check(input, "cloudflare image", BASE);
      a.opt("--prompt", input.prompt).opt("--model", input.model).opt("--output", input.output);
      return { command: "cloudflare generate", args: a.list, variant: "image", writesOutput: true };
    }
    if (input.task !== "video") throw unsupported("cloudflare", input.task);
    const label = "cloudflare video";
    const a = check(input, label, [
      ...BASE,
      "duration",
      "aspectRatio",
      "resolution",
      "async",
      "waitTimeout",
    ]);
    fixedModel(label, input.model, CLOUDFLARE_VIDEO_MODEL);
    a.opt("--prompt", input.prompt).opt("--duration", input.duration);
    a.opt("--aspect-ratio", input.aspectRatio).opt("--resolution", input.resolution);
    waitUnlessAsync(a, input, "--download").opt("--output", input.output);
    return {
      command: "cloudflare generate-video",
      args: a.list,
      variant: "video",
      writesOutput: true,
    };
  },
};

/** fal image_size presets by aspect ratio. */
const FAL_SIZES: Readonly<Record<string, string>> = {
  "1:1": "square_hd",
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
  "4:3": "landscape_4_3",
  "3:4": "portrait_4_3",
};

const fal: GenerateAdapter = {
  serves: { image: ["image"], video: ["video", "image-to-video"] },
  anyModel: () => true,
  defaultModel: (task) =>
    task === "image" ? "fal-ai/flux/schnell" : "fal-ai/kling-video/v1.6/standard/text-to-video",
  staticModels: (task) =>
    task === "image"
      ? [{ id: "fal-ai/flux/schnell", label: "FLUX.1 [schnell]", tasks: ["image"] }]
      : [
          { id: "fal-ai/kling-video/v1.6/standard/text-to-video", tasks: ["video"] },
          { id: "fal-ai/kling-video/v1.6/standard/image-to-video", tasks: ["image-to-video"] },
        ],
  plan(input) {
    if (input.task === "image") {
      const a = check(input, "fal image (text-to-image)", [
        ...BASE,
        "aspectRatio",
        "numImages",
        "waitTimeout",
      ]);
      let size: string | undefined;
      if (input.aspectRatio !== undefined) {
        size = FAL_SIZES[input.aspectRatio];
        if (!size) {
          throw new ConfigError(
            `fal image takes --aspect-ratio ${Object.keys(FAL_SIZES).join(", ")} only`,
          );
        }
      }
      a.pos(input.prompt).opt("--model", input.model).opt("--image-size", size);
      a.opt("--num-images", input.numImages);
      timeout(a, input).opt("--output", input.output);
      return { command: "fal image", args: a.list, variant: "image", writesOutput: true };
    }
    if (input.task !== "video") throw unsupported("fal", input.task);
    const label = "fal video";
    const a = check(input, label, [...BASE, "images", "duration", "aspectRatio", "waitTimeout"]);
    atMost(label, "--image", input.images, 1);
    requireUrls(label, "--image", input.images);
    a.pos(input.prompt).opt("--model", input.model).opt("--image-url", input.images[0]);
    a.opt("--duration", input.duration).opt("--aspect-ratio", input.aspectRatio);
    timeout(a, input);
    return {
      command: "fal video",
      args: a.list,
      variant: input.images.length ? "image-to-video" : "video",
      writesOutput: false,
    };
  },
};

const atlas: GenerateAdapter = {
  serves: { image: ["image", "image-edit"], video: ["video", "image-to-video"] },
  anyModel: () => true,
  defaultModel: (task) =>
    task === "image"
      ? "black-forest-labs/flux-schnell"
      : "bytedance/seedance-v1-pro-fast/text-to-video",
  staticModels: (task) =>
    task === "image"
      ? [
          { id: "black-forest-labs/flux-schnell", tasks: ["image"] },
          { id: "openai/gpt-image-1-mini/edit", tasks: ["image-edit"] },
        ]
      : [
          { id: "bytedance/seedance-v1-pro-fast/text-to-video", tasks: ["video"] },
          { id: "bytedance/seedance-v1-pro-fast/image-to-video", tasks: ["image-to-video"] },
        ],
  plan(input) {
    const common: Field[] = [...BASE, "resolution", "aspectRatio", "async", "waitTimeout"];
    const finish = (a: Args) => {
      a.opt("--model", input.model).opt("--resolution", input.resolution);
      a.opt("--aspect-ratio", input.aspectRatio).bool("--async", input.async);
      timeout(a, input).opt("--output", input.output);
      return a.list;
    };
    if (input.task === "image") {
      const edit = input.images.length > 0;
      const a = check(input, edit ? "atlas image edit" : "atlas image", [
        ...common,
        "numImages",
        ...(edit ? (["images"] as Field[]) : []),
      ]);
      if (edit) a.opt("--prompt", input.prompt).each("--ref", input.images);
      else a.pos(input.prompt);
      a.opt("--num-images", input.numImages);
      return edit
        ? {
            command: "atlas image-to-image",
            args: finish(a),
            variant: "image-edit",
            writesOutput: true,
          }
        : { command: "atlas image", args: finish(a), variant: "image", writesOutput: true };
    }
    if (input.task !== "video") throw unsupported("atlas", input.task);
    const i2v = input.images.length > 0;
    const a = check(input, i2v ? "atlas image-to-video" : "atlas video", [
      ...common,
      "duration",
      ...(i2v ? (["images"] as Field[]) : []),
    ]);
    if (i2v) a.opt("--prompt", input.prompt).each("--ref", input.images);
    else a.pos(input.prompt);
    a.opt("--duration", input.duration);
    return i2v
      ? {
          command: "atlas image-to-video",
          args: finish(a),
          variant: "image-to-video",
          writesOutput: true,
        }
      : { command: "atlas video", args: finish(a), variant: "video", writesOutput: true };
  },
};

const replicate: GenerateAdapter = {
  serves: { image: ["image"], video: ["video", "image-to-video"] },
  anyModel: () => true,
  defaultModel: (task) => (task === "image" ? "black-forest-labs/flux-schnell" : "prunaai/p-video"),
  staticModels: (task) =>
    task === "image"
      ? [{ id: "black-forest-labs/flux-schnell", tasks: ["image"] }]
      : [{ id: "prunaai/p-video", tasks: ["video", "image-to-video"] }],
  plan(input) {
    if (input.task === "image") {
      const a = check(input, "replicate image (text-to-image)", [
        ...BASE,
        "aspectRatio",
        "numImages",
        "async",
        "waitTimeout",
      ]);
      a.pos(input.prompt).opt("--model", input.model).opt("--aspect-ratio", input.aspectRatio);
      a.opt("--num-outputs", input.numImages).bool("--async", input.async);
      timeout(a, input).opt("--output", input.output);
      return { command: "replicate image", args: a.list, variant: "image", writesOutput: true };
    }
    if (input.task !== "video") throw unsupported("replicate", input.task);
    const label = "replicate video";
    const a = check(input, label, [
      ...BASE,
      "images",
      "duration",
      "aspectRatio",
      "resolution",
      "async",
      "waitTimeout",
    ]);
    atMost(label, "--image", input.images, 1);
    a.pos(input.prompt).opt("--model", input.model).opt("--image", input.images[0]);
    a.opt("--duration", input.duration).opt("--aspect-ratio", input.aspectRatio);
    a.opt("--resolution", input.resolution).bool("--async", input.async);
    timeout(a, input).opt("--output", input.output);
    return {
      command: "replicate video",
      args: a.list,
      variant: input.images.length ? "image-to-video" : "video",
      writesOutput: true,
    };
  },
};

/** The ratio in `ratios` with the aspect ratio `aspect` ("16:9"), or `aspect` itself in pixels ("1280:720"). */
export function runwayRatio(
  aspect: string | undefined,
  ratios: readonly string[],
): string | undefined {
  if (aspect === undefined) return undefined;
  if (ratios.includes(aspect)) return aspect;
  const m = aspect.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  const want = m ? Number(m[1]) / Number(m[2]) : Number.NaN;
  const found = ratios.find((r) => {
    const [w, h] = r.split(":").map(Number);
    return w && h && Math.abs(w / h - want) / want < 0.01;
  });
  if (!found) {
    throw new ConfigError(`runway takes --aspect-ratio matching one of ${ratios.join(", ")}`);
  }
  return found;
}

const runway: GenerateAdapter = {
  serves: { image: ["image", "image-edit"], video: ["video", "image-to-video"] },
  defaultModel: (task) => (task === "image" ? "gen4_image" : "gen4.5"),
  staticModels: (task) =>
    task === "image"
      ? Object.entries(RUNWAY_IMAGE_MODELS).map(([id, spec]) => ({
          id,
          tasks: spec.minReferences > 0 ? ["image-edit"] : ["image", "image-edit"],
        }))
      : Object.entries(RUNWAY_VIDEO_MODELS).map(([id, spec]) => ({
          id,
          tasks: spec.textRatios ? ["video", "image-to-video"] : ["image-to-video"],
        })),
  plan(input) {
    if (input.task === "image") {
      const label = "runway image";
      const a = check(input, label, [...BASE, "images", "aspectRatio", "async", "waitTimeout"]);
      atMost(label, "--image", input.images, 3);
      const spec = RUNWAY_IMAGE_MODELS[input.model ?? "gen4_image"];
      a.pos(input.prompt).opt("--model", input.model);
      a.opt("--ratio", spec ? runwayRatio(input.aspectRatio, spec.ratios) : input.aspectRatio);
      a.each("--reference", input.images).bool("--async", input.async);
      timeout(a, input).opt("--output", input.output);
      return {
        command: "runway image",
        args: a.list,
        variant: input.images.length ? "image-edit" : "image",
        writesOutput: true,
      };
    }
    if (input.task !== "video") throw unsupported("runway", input.task);
    const label = "runway video";
    const a = check(input, label, [
      ...BASE,
      "images",
      "aspectRatio",
      "duration",
      "async",
      "waitTimeout",
    ]);
    atMost(label, "--image", input.images, 1);
    const spec = RUNWAY_VIDEO_MODELS[input.model ?? "gen4.5"];
    const ratios = (input.images.length ? spec?.imageRatios : spec?.textRatios) ?? [];
    a.pos(input.prompt).opt("--model", input.model).opt("--image", input.images[0]);
    a.opt("--ratio", ratios.length ? runwayRatio(input.aspectRatio, ratios) : input.aspectRatio);
    a.opt("--duration", input.duration);
    waitUnlessAsync(a, input, "--wait").opt("--output", input.output);
    return {
      command: "runway video",
      args: a.list,
      variant: input.images.length ? "image-to-video" : "video",
      writesOutput: true,
    };
  },
};

const heygen: GenerateAdapter = {
  serves: { video: ["video", "image-to-video"], lipsync: ["lipsync"] },
  defaultModel: (task) => (task === "video" ? HEYGEN_VIDEO_MODEL : undefined),
  staticModels: (task) =>
    task === "video"
      ? [{ id: HEYGEN_VIDEO_MODEL, label: "HeyGen Video", tasks: ["video", "image-to-video"] }]
      : [
          { id: "speed", label: "Lip-sync (speed)", tasks: ["lipsync"] },
          { id: "precision", label: "Lip-sync (precision)", tasks: ["lipsync"] },
        ],
  plan(input) {
    if (input.task === "lipsync") {
      const label = "heygen lipsync";
      const a = check(input, label, ["model", "video", "audio", "output", "async", "waitTimeout"]);
      needs(label, input.video !== undefined && input.audio !== undefined, "--video and --audio");
      if (input.model !== undefined && input.model !== "speed" && input.model !== "precision") {
        throw new ConfigError(`${label} takes --model speed or precision`);
      }
      a.opt("--video", input.video).opt("--audio", input.audio).opt("--mode", input.model);
      a.bool("--async", input.async);
      timeout(a, input).opt("--output", input.output);
      return { command: "heygen lipsync", args: a.list, variant: "lipsync", writesOutput: true };
    }
    if (input.task !== "video") throw unsupported("heygen", input.task);
    const label = "heygen video";
    const a = check(input, label, [
      ...BASE,
      "images",
      "duration",
      "resolution",
      "aspectRatio",
      "async",
      "waitTimeout",
    ]);
    fixedModel(label, input.model, HEYGEN_VIDEO_MODEL);
    const [first, ...refs] = input.images;
    a.pos(input.prompt).opt("--image", first).each("--reference-image", refs);
    a.opt("--duration", input.duration).opt("--resolution", input.resolution);
    a.opt("--aspect-ratio", input.aspectRatio).bool("--async", input.async);
    timeout(a, input).opt("--output", input.output);
    return {
      command: "heygen model-video",
      args: a.list,
      variant: input.images.length ? "image-to-video" : "video",
      writesOutput: true,
    };
  },
};

const sume: GenerateAdapter = {
  serves: {
    image: ["image", "image-edit"],
    video: ["video", "image-to-video"],
    lipsync: ["lipsync"],
  },
  anyModel: () => true,
  staticModels: () => [],
  plan(input) {
    if (input.task === "image") {
      const a = check(input, "sume image", [
        ...BASE,
        "images",
        "aspectRatio",
        "resolution",
        "numImages",
        "async",
        "waitTimeout",
      ]);
      a.pos(input.prompt).opt("--model", input.model).each("--image", input.images);
      a.opt("--aspect-ratio", input.aspectRatio).opt("--resolution", input.resolution);
      a.opt("--num-images", input.numImages);
      waitUnlessAsync(a, input, "--wait").opt("--output", input.output);
      return {
        command: "sume image",
        args: a.list,
        variant: input.images.length ? "image-edit" : "image",
        writesOutput: true,
      };
    }
    if (input.task !== "video" && input.task !== "lipsync") throw unsupported("sume", input.task);
    const lipsync = input.task === "lipsync";
    const label = lipsync ? "sume lipsync" : "sume video";
    const a = check(input, label, [
      ...BASE,
      "images",
      "endImage",
      "video",
      "audio",
      "duration",
      "resolution",
      "aspectRatio",
      "generateAudio",
      "async",
      "waitTimeout",
    ]);
    if (lipsync) {
      needs(label, input.audio !== undefined, "--audio");
      needs(label, input.images.length > 0 || input.video !== undefined, "--image or --video");
    }
    const [first, ...refs] = input.images;
    a.pos(input.prompt).opt("--model", input.model).opt("--image", first);
    a.opt("--end-image", input.endImage).each("--reference-image", refs);
    a.opt("--video", input.video).opt("--audio", input.audio).opt("--duration", input.duration);
    a.opt("--resolution", input.resolution).opt("--aspect-ratio", input.aspectRatio);
    if (input.generateAudio !== undefined) {
      a.bool(input.generateAudio ? "--generate-audio" : "--no-generate-audio", true);
    }
    waitUnlessAsync(a, input, "--wait").opt("--output", input.output);
    return {
      command: "sume video",
      args: a.list,
      variant: lipsync ? "lipsync" : input.images.length ? "image-to-video" : "video",
      writesOutput: true,
    };
  },
};

/** TopView API Platform video models whose routes take the `content` body. */
export function topviewVideoModels(): ModelEntry[] {
  const byBase = new Map<string, ModelEntry>();
  for (const r of PLATFORM_ROUTES) {
    if (r.category !== "video" || r.family !== "content") continue;
    const base = r.route.slice(0, r.route.lastIndexOf("/"));
    const mode = r.route.slice(base.length + 1);
    const task: Task | undefined =
      mode === "text-to-video" ? "video" : mode === "image-to-video" ? "image-to-video" : undefined;
    if (!task) continue;
    const entry = byBase.get(base) ?? { id: base, label: r.catalogName, tasks: [] };
    entry.tasks.push(task);
    byBase.set(base, entry);
  }
  return [...byBase.values()];
}

const TOPVIEW_IMAGE_MODEL = "openai/gpt-image-2";
const TOPVIEW_VIDEO_MODEL = "bytedance/seedance-2.0";

const topview: GenerateAdapter = {
  serves: { image: ["image"], video: ["video", "image-to-video"] },
  defaultModel: (task) => (task === "image" ? TOPVIEW_IMAGE_MODEL : TOPVIEW_VIDEO_MODEL),
  staticModels: (task) =>
    task === "image"
      ? [{ id: TOPVIEW_IMAGE_MODEL, label: "GPT Image 2", tasks: ["image"] }]
      : topviewVideoModels(),
  plan(input) {
    if (input.task === "image") {
      const label = "topview image (API Platform text-to-image)";
      const a = check(input, label, [...BASE, "async", "waitTimeout"]);
      fixedModel(label, input.model, TOPVIEW_IMAGE_MODEL);
      needs(label, Boolean(input.prompt), "a prompt");
      a.pos(`${TOPVIEW_IMAGE_MODEL}/text-to-image`).opt(
        "--input",
        JSON.stringify({ prompt: input.prompt }),
      );
      waitUnlessAsync(a, input, "--wait").opt("--output", input.output);
      return { command: "topview run", args: a.list, variant: "image", writesOutput: true };
    }
    if (input.task !== "video") throw unsupported("topview", input.task);
    const label = "topview video (API Platform)";
    const a = check(input, label, [
      ...BASE,
      "images",
      "endImage",
      "duration",
      "resolution",
      "aspectRatio",
      "generateAudio",
      "async",
      "waitTimeout",
    ]);
    const model = input.model ?? TOPVIEW_VIDEO_MODEL;
    const variant: Task = input.images.length ? "image-to-video" : "video";
    const entry = topviewVideoModels().find((m) => m.id === model);
    if (!entry?.tasks.includes(variant)) {
      const valid = topviewVideoModels()
        .filter((m) => m.tasks.includes(variant))
        .map((m) => m.id);
      throw new ConfigError(
        `topview ${variant} through generate takes --model ${valid.join(", ")}; run other routes with \`multix topview run\``,
      );
    }
    atMost(label, "--image (use --end-image for the last frame)", input.images, 1);
    if (input.endImage !== undefined)
      needs(label, input.images.length === 1, "--image with --end-image");
    requireUrls(label, "--image/--end-image", [...input.images, input.endImage]);
    let duration: number | undefined;
    if (input.duration !== undefined) {
      duration = Number(input.duration);
      if (!Number.isInteger(duration))
        throw new ConfigError(`${label} takes --duration in whole seconds`);
    }
    const frame = (url: string, role: string) => ({ type: "image_url", image_url: { url }, role });
    const body = {
      content: [
        ...(input.prompt ? [{ type: "text", text: input.prompt }] : []),
        ...input.images.map((url) => frame(url, "first_frame")),
        ...(input.endImage ? [frame(input.endImage, "last_frame")] : []),
      ],
      ...(duration !== undefined ? { duration } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.aspectRatio ? { ratio: input.aspectRatio } : {}),
      ...(input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {}),
    };
    needs(label, body.content.length > 0, "a prompt or --image");
    a.pos(`${model}/${variant === "video" ? "text-to-video" : "image-to-video"}`);
    a.opt("--input", JSON.stringify(body));
    waitUnlessAsync(a, input, "--wait").opt("--output", input.output);
    return { command: "topview run", args: a.list, variant, writesOutput: true };
  },
};

function unsupported(provider: string, task: GenerateTask): ConfigError {
  return new ConfigError(
    `${provider} cannot ${task === "lipsync" ? "lip-sync" : task} through multix generate. Providers that can: ${providersFor(task).join(", ")}`,
  );
}

export const GENERATE_ADAPTERS: Readonly<Record<string, GenerateAdapter>> = {
  gemini,
  minimax,
  openai,
  openrouter,
  leonardo,
  byteplus,
  cloudflare,
  fal,
  atlas,
  replicate,
  runway,
  sume,
  topview,
  heygen,
};

export const GENERATE_PROVIDERS = Object.keys(GENERATE_ADAPTERS);

/** Providers whose adapter serves `task`. */
export function providersFor(task: GenerateTask): string[] {
  return GENERATE_PROVIDERS.filter((p) => GENERATE_ADAPTERS[p]?.serves[task] !== undefined);
}

/** The adapter for `provider` and `task`, or a ConfigError naming the ones that serve it. */
export function adapterFor(provider: string, task: GenerateTask): GenerateAdapter {
  const adapter = GENERATE_ADAPTERS[provider];
  if (!adapter) {
    throw new ConfigError(
      `Unknown provider "${provider}" for multix generate. Valid: ${GENERATE_PROVIDERS.join(", ")}`,
    );
  }
  if (!adapter.serves[task]) throw unsupported(provider, task);
  return adapter;
}

/**
 * Provider and model from --provider and --model. `--model fal:fal-ai/flux/dev`
 * names both; only a known provider prefix is split off, so model ids that
 * contain a colon (`owner/name:version`) stay whole.
 */
export function resolveRoute(
  provider: string | undefined,
  model: string | undefined,
): { provider: string; model?: string } {
  const colon = model?.indexOf(":") ?? -1;
  const prefix = model && colon > 0 ? model.slice(0, colon) : undefined;
  if (prefix && GENERATE_ADAPTERS[prefix] && (provider === undefined || provider === prefix)) {
    const rest = (model as string).slice(colon + 1);
    if (!rest) throw new ConfigError(`--model ${model} names no model after "${prefix}:"`);
    return { provider: prefix, model: rest };
  }
  if (provider === undefined) {
    throw new ConfigError(
      `--provider is required (or --model <provider>:<model>). Valid: ${GENERATE_PROVIDERS.join(", ")}`,
    );
  }
  return { provider, ...(model !== undefined ? { model } : {}) };
}
