/**
 * Content types for media uploads (Atlas Cloud, fal storage), keyed by file
 * extension. Runtime-neutral. Providers classify uploads by name and models
 * check the URL extension, so the original extension is kept and an explicit
 * type is sent instead of application/octet-stream.
 */

const UPLOAD_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  opus: "audio/opus",
};

/** Extensions accepted for upload: image, video and audio media only. */
export const UPLOAD_EXTENSIONS: readonly string[] = Object.keys(UPLOAD_MIME_TYPES);

/** Content type for a supported media file, or undefined when the extension is not media. */
export function uploadMimeTypeFor(filename: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? "";
  return UPLOAD_MIME_TYPES[ext];
}

export function guessUploadMimeType(filename: string): string {
  return uploadMimeTypeFor(filename) ?? "application/octet-stream";
}
