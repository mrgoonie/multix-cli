/**
 * Detect media type from file extension.
 * Mirrors the extension sets from media_optimizer.py.
 */

const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".mpg", ".mpeg"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg", ".aiff"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp"]);

export type MediaKind = "video" | "audio" | "image";

/**
 * Returns the media kind for a file extension (with leading dot), or undefined if unsupported.
 * Extension should be lowercase and include the dot (e.g. ".mp4").
 */
export function extToKind(ext: string): MediaKind | undefined {
  const lower = ext.toLowerCase();
  if (VIDEO_EXTS.has(lower)) return "video";
  if (AUDIO_EXTS.has(lower)) return "audio";
  if (IMAGE_EXTS.has(lower)) return "image";
  return undefined;
}

export { VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS };
