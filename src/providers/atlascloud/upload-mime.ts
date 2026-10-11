/**
 * Content types for Atlas Cloud uploads, keyed by file extension.
 * Runtime-neutral. Atlas classifies uploads by name and models check the URL
 * extension, so the original extension is kept and an explicit type is sent
 * instead of application/octet-stream.
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

export function guessUploadMimeType(filename: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? "";
  return UPLOAD_MIME_TYPES[ext] ?? "application/octet-stream";
}
