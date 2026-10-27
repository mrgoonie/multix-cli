/**
 * Container detection from magic bytes, so `media inspect` can tell a file's
 * real format from the one its extension claims. Reuses the image and audio
 * sniffers and adds the common video containers.
 */

import { looksLikeText, sniffAudioKind } from "../../core/audio-kind.js";
import { sniffImageKind } from "../../core/image-header.js";
import { type MediaKind, extToKind } from "./detect-type.js";

export interface SniffResult {
  /** Container named from the bytes, or null when the header is not recognised. */
  container: string | null;
  kind: MediaKind | null;
  /** Extensions (without dot) that this container is normally saved under. */
  extensions: string[];
}

function ascii(buf: Buffer, start: number, text: string): boolean {
  return (
    buf.length >= start + text.length && buf.toString("latin1", start, start + text.length) === text
  );
}

const UNKNOWN: SniffResult = { container: null, kind: null, extensions: [] };

/** Names the container of `buf` (the first few KB of a file). */
export function sniffContainer(buf: Buffer): SniffResult {
  const image = sniffImageKind(buf);
  if (image)
    return {
      container: image,
      kind: "image",
      extensions: image === "jpeg" ? ["jpg", "jpeg"] : [image],
    };
  if (ascii(buf, 0, "GIF87a") || ascii(buf, 0, "GIF89a"))
    return { container: "gif", kind: "image", extensions: ["gif"] };
  if (ascii(buf, 0, "BM") && buf.length >= 26)
    return { container: "bmp", kind: "image", extensions: ["bmp"] };
  if (ascii(buf, 4, "ftyp")) {
    const brand = buf.toString("latin1", 8, 12);
    if (brand === "qt  ") return { container: "mov", kind: "video", extensions: ["mov"] };
    if (/^M4[AB] /.test(brand))
      return { container: "m4a", kind: "audio", extensions: ["m4a", "mp4"] };
    if (/^(heic|heix|mif1|msf1|avif)$/.test(brand))
      return {
        container: brand === "avif" ? "avif" : "heif",
        kind: "image",
        extensions: ["heic", "heif", "avif"],
      };
    // An MP4 can hold audio only; ffprobe decides the kind from its streams.
    return { container: "mp4", kind: "video", extensions: ["mp4", "m4v", "mov", "m4a"] };
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    // The EBML header names the DocType (webm or matroska) within its first bytes.
    const head = buf.toString("latin1", 0, Math.min(buf.length, 64));
    return head.includes("webm")
      ? { container: "webm", kind: "video", extensions: ["webm", "weba"] }
      : { container: "matroska", kind: "video", extensions: ["mkv", "mka", "webm"] };
  }
  if (ascii(buf, 0, "RIFF") && ascii(buf, 8, "AVI "))
    return { container: "avi", kind: "video", extensions: ["avi"] };
  if (ascii(buf, 0, "FLV")) return { container: "flv", kind: "video", extensions: ["flv"] };
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0xba)
    return { container: "mpeg-ps", kind: "video", extensions: ["mpg", "mpeg"] };
  if (buf[0] === 0x47 && buf[188] === 0x47)
    return { container: "mpeg-ts", kind: "video", extensions: ["ts", "mts", "m2ts"] };
  const audio = sniffAudioKind(buf);
  if (audio) {
    const extensions =
      audio === "ogg" ? ["ogg", "oga", "opus"] : audio === "aiff" ? ["aiff", "aif"] : [audio];
    return { container: audio, kind: audio === "webm" ? "video" : "audio", extensions };
  }
  if (looksLikeText(buf) || ascii(buf, 0, "#EXTM3U") || ascii(buf, 0, "ffconcat"))
    return { container: "text", kind: null, extensions: [] };
  return UNKNOWN;
}

/** Whether the file's extension is one its sniffed container is saved under; null when either is unknown. */
export function extensionMatches(ext: string, sniff: SniffResult): boolean | null {
  const bare = ext.replace(/^\./, "").toLowerCase();
  if (!bare || !sniff.container) return null;
  if (sniff.extensions.includes(bare)) return true;
  // An extension multix does not know (e.g. .bin) proves nothing either way.
  return extToKind(`.${bare}`) ? false : null;
}

/**
 * Bytes a WAV's `data` chunk header declares against the bytes the file still holds after
 * it. Null when the file is not a WAV, the chunk header lies beyond `head`, or the size is
 * a streaming placeholder (0 or 0xFFFFFFFF) that declares nothing.
 */
export function wavDataSize(
  head: Buffer,
  fileBytes: number,
): { declared_bytes: number; present_bytes: number } | null {
  if (!ascii(head, 0, "RIFF") || !ascii(head, 8, "WAVE")) return null;
  let at = 12;
  while (at + 8 <= head.length) {
    const size = head.readUInt32LE(at + 4);
    if (ascii(head, at, "data")) {
      if (size === 0 || size === 0xffffffff) return null;
      return { declared_bytes: size, present_bytes: Math.max(0, fileBytes - at - 8) };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
