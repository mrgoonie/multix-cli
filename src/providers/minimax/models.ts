/**
 * MiniMax model registries and task defaults.
 * Mirrors minimax_generate.py model sets exactly.
 */

export const MINIMAX_IMAGE_MODELS = new Set(["image-01", "image-01-live"]);

export const MINIMAX_VIDEO_MODELS = new Set([
  "MiniMax-Hailuo-2.3",
  "MiniMax-Hailuo-2.3-Fast",
  "MiniMax-Hailuo-02",
  "S2V-01",
]);

export const MINIMAX_SPEECH_MODELS = new Set([
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
]);

export const MINIMAX_MUSIC_MODELS = new Set(["music-2.5", "music-2.0"]);

export const ALL_MINIMAX_MODELS = new Set([
  ...MINIMAX_IMAGE_MODELS,
  ...MINIMAX_VIDEO_MODELS,
  ...MINIMAX_SPEECH_MODELS,
  ...MINIMAX_MUSIC_MODELS,
]);

/** Task-level defaults (from env or hardcoded fallback). */
export const TASK_DEFAULTS = {
  image: process.env.MINIMAX_IMAGE_MODEL ?? "image-01",
  video: process.env.MINIMAX_VIDEO_MODEL ?? "MiniMax-Hailuo-2.3",
  speech: process.env.MINIMAX_SPEECH_MODEL ?? "speech-2.8-hd",
  music: process.env.MINIMAX_MUSIC_MODEL ?? "music-2.5",
} as const;

/** Heuristic: is this a MiniMax model id? */
export function isMinimaxModel(model: string): boolean {
  return (
    ALL_MINIMAX_MODELS.has(model) ||
    model.startsWith("MiniMax-") ||
    model.startsWith("image-01") ||
    model.startsWith("speech-") ||
    model.startsWith("music-") ||
    model.startsWith("S2V-")
  );
}

/** Supported video durations (seconds). */
export const VIDEO_DURATIONS = [6, 10] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];

/** Supported video resolutions. */
export const VIDEO_RESOLUTIONS = ["720P", "1080P"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

/** Supported speech output formats. */
export const SPEECH_FORMATS = ["mp3", "wav", "flac", "pcm"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];
