/**
 * Audio container detection from magic bytes, and the file extension for an
 * audio MIME type. Lets a download be saved under the extension its bytes
 * really have, whatever the URL or Content-Type claimed.
 * Runtime-neutral: takes bytes, no `node:*` imports.
 */

export type AudioKind = "wav" | "mp3" | "ogg" | "flac" | "m4a" | "aac" | "webm" | "aiff";

function ascii(buf: Uint8Array, start: number, text: string): boolean {
  if (buf.length < start + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buf[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The audio container of `buf` from its first bytes, or undefined when it has
 * no recognisable header (raw PCM, mu-law and A-law have none). MP3 and ADTS
 * AAC without a tag start with an 11-bit frame sync only, which raw samples
 * can match by chance (0xFFFF is -1 in 16-bit PCM): pass `frameSync: false`
 * when the bytes are expected to be raw.
 */
export function sniffAudioKind(
  buf: Uint8Array,
  opts: { frameSync?: boolean } = {},
): AudioKind | undefined {
  if (ascii(buf, 0, "RIFF") && ascii(buf, 8, "WAVE")) return "wav";
  if (ascii(buf, 0, "FORM") && (ascii(buf, 8, "AIFF") || ascii(buf, 8, "AIFC"))) return "aiff";
  if (ascii(buf, 0, "OggS")) return "ogg";
  if (ascii(buf, 0, "fLaC")) return "flac";
  if (ascii(buf, 4, "ftyp")) return "m4a";
  if (ascii(buf, 0, "ID3")) return "mp3";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
  const b0 = buf[0];
  const b1 = buf[1];
  if (opts.frameSync !== false && b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0) {
    // Frame sync: ADTS AAC has layer bits 00; MPEG audio layers I-III do not.
    return (b1 & 0x06) === 0 ? "aac" : "mp3";
  }
  return undefined;
}

/** True when the bytes start like text (HTML, JSON or XML), i.e. an error page rather than audio. */
export function looksLikeText(buf: Uint8Array): boolean {
  let i = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3; // UTF-8 BOM
  while (i < buf.length && [0x09, 0x0a, 0x0d, 0x20].includes(buf[i] as number)) i++;
  const c = buf[i];
  return c === 0x3c /* < */ || c === 0x7b /* { */ || c === 0x5b /* [ */;
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/vnd.wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/webm": "webm",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "audio/basic": "ulaw",
  "audio/pcm": "pcm",
  "audio/l16": "pcm",
};

/** Extension (without dot) for an audio MIME type, ignoring parameters; undefined when unknown. */
export function audioExtFromMime(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  return EXT_BY_MIME[mime.split(";")[0]?.trim().toLowerCase() ?? ""];
}
