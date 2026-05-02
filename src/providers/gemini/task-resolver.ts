/**
 * Infer Gemini task type and MIME type from file extension.
 * Mirrors gemini_batch_process.py: infer_task_from_file / get_mime_type.
 */

import path from "node:path";

export type GeminiTask = "transcribe" | "analyze" | "extract";

const AUDIO_EXTS = new Set([".mp3", ".wav", ".aac", ".flac", ".ogg", ".aiff", ".m4a"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp"]);
const VIDEO_EXTS = new Set([
  ".mp4",
  ".mpeg",
  ".mov",
  ".avi",
  ".flv",
  ".mpg",
  ".webm",
  ".wmv",
  ".3gpp",
  ".mkv",
]);
const DOC_EXTS = new Set([".pdf", ".txt", ".html", ".md", ".doc", ".docx"]);

/** Infer the analysis task from a file path's extension. */
export function inferTaskFromFile(filePath: string): GeminiTask {
  const ext = path.extname(filePath).toLowerCase();
  if (AUDIO_EXTS.has(ext)) return "transcribe";
  if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) return "analyze";
  if (DOC_EXTS.has(ext)) return "extract";
  return "analyze"; // default for unknown types
}

const MIME_MAP: Record<string, string> = {
  // Audio
  ".mp3": "audio/mp3",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".aiff": "audio/aiff",
  ".m4a": "audio/mp4",
  // Image
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  // Video
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".webm": "video/webm",
  ".wmv": "video/x-ms-wmv",
  ".3gpp": "video/3gpp",
  // Document
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Get MIME type for a file path. Falls back to application/octet-stream. */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

/** True if the MIME type is audio or video (requires polling after File API upload). */
export function requiresProcessingWait(mimeType: string): boolean {
  return mimeType.startsWith("audio/") || mimeType.startsWith("video/");
}
