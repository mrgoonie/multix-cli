/**
 * Check the audio Fish returned against the format that was asked for, and
 * read its sample rate, channels and duration from the bytes (runtime-neutral:
 * no `node:*` imports). A 200 with a body is not proof of audio: an error page
 * or the wrong container is caught here before the file is reported as done.
 */

import { looksLikeText, sniffAudioKind } from "../../core/audio-kind.js";
import type { FishTtsFormat } from "./models.js";

export interface AudioCheck {
  /** Container the bytes really are; "pcm" when headerless bytes were asked for. */
  kind: string | null;
  /** True when the bytes are the requested container. */
  signature_ok: boolean;
  sample_rate_hz: number | null;
  channels: number | null;
  duration_s: number | null;
  /** Where duration_s came from. */
  duration_source: "header" | "frames" | "granule" | "pcm_size" | null;
  problems: string[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function ascii(buf: Uint8Array, start: number, text: string): boolean {
  if (buf.length < start + text.length) return false;
  for (let i = 0; i < text.length; i++) if (buf[start + i] !== text.charCodeAt(i)) return false;
  return true;
}

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** WAV: walk the RIFF chunks for `fmt ` and `data`. Streamed WAVs may carry a placeholder data size. */
function wavInfo(buf: Uint8Array): Pick<AudioCheck, "sample_rate_hz" | "channels" | "duration_s"> {
  const dv = view(buf);
  let offset = 12;
  let rate: number | null = null;
  let channels: number | null = null;
  let byteRate = 0;
  while (offset + 8 <= buf.length) {
    const size = dv.getUint32(offset + 4, true);
    if (ascii(buf, offset, "fmt ") && offset + 24 <= buf.length) {
      channels = dv.getUint16(offset + 10, true);
      rate = dv.getUint32(offset + 12, true);
      byteRate = dv.getUint32(offset + 16, true);
    }
    if (ascii(buf, offset, "data")) {
      const available = buf.length - offset - 8;
      const dataBytes = size > 0 && size <= available ? size : available;
      return {
        sample_rate_hz: rate,
        channels,
        duration_s: byteRate > 0 ? round(dataBytes / byteRate) : null,
      };
    }
    offset += 8 + size + (size % 2);
  }
  return { sample_rate_hz: rate, channels, duration_s: null };
}

const MP3_BITRATES: Record<string, number[]> = {
  // kbps by index for Layer III: MPEG-1, and MPEG-2/2.5.
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, number[]> = {
  3: [44_100, 48_000, 32_000], // MPEG-1
  2: [22_050, 24_000, 16_000], // MPEG-2
  0: [11_025, 12_000, 8_000], // MPEG-2.5
};

interface Mp3Frame {
  length: number;
  rate: number;
  samples: number;
  channels: number;
}

function mp3Frame(buf: Uint8Array, at: number): Mp3Frame | undefined {
  if (at + 4 > buf.length || buf[at] !== 0xff || ((buf[at + 1] ?? 0) & 0xe0) !== 0xe0) {
    return undefined;
  }
  const b1 = buf[at + 1] ?? 0;
  const b2 = buf[at + 2] ?? 0;
  const b3 = buf[at + 3] ?? 0;
  const version = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  if (version === 1 || layer !== 1) return undefined; // reserved version, or not Layer III
  const kbps = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)?.[(b2 >> 4) & 15];
  const rate = MP3_RATES[version]?.[(b2 >> 2) & 3];
  if (!kbps || !rate) return undefined;
  const samples = version === 3 ? 1152 : 576;
  const padding = (b2 >> 1) & 1;
  const length = Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
  return { length, rate, samples, channels: b3 >> 6 === 3 ? 1 : 2 };
}

/** MP3: skip an ID3v2 tag, then walk the frames and add up their samples. */
function mp3Info(buf: Uint8Array): Pick<AudioCheck, "sample_rate_hz" | "channels" | "duration_s"> {
  let at = 0;
  if (ascii(buf, 0, "ID3") && buf.length >= 10) {
    const size =
      (((buf[6] ?? 0) & 0x7f) << 21) |
      (((buf[7] ?? 0) & 0x7f) << 14) |
      (((buf[8] ?? 0) & 0x7f) << 7) |
      ((buf[9] ?? 0) & 0x7f);
    at = 10 + size;
  }
  const first = mp3Frame(buf, at);
  if (!first) return { sample_rate_hz: null, channels: null, duration_s: null };
  let samples = 0;
  let frames = 0;
  // A Xing/Info/VBRI frame at the start is metadata: walk past it without counting its samples.
  const firstEnd = Math.min(buf.length, at + first.length);
  for (const tag of ["Xing", "Info", "VBRI"]) {
    const found = indexOf(buf.subarray(at, firstEnd), tag, 4);
    if (found >= 0) {
      at += first.length;
      break;
    }
  }
  while (at < buf.length) {
    const frame = mp3Frame(buf, at);
    if (!frame || frame.rate !== first.rate) break;
    samples += frame.samples;
    frames++;
    at += frame.length;
  }
  // A walk that stopped well before the end met something it cannot read: no duration.
  const complete = frames > 0 && buf.length - at < first.length * 2;
  return {
    sample_rate_hz: first.rate,
    channels: first.channels,
    duration_s: complete ? round(samples / first.rate) : null,
  };
}

/** Ogg Opus: 48 kHz output; length = last page's granule position minus the pre-skip. */
function opusInfo(buf: Uint8Array): Pick<AudioCheck, "sample_rate_hz" | "channels" | "duration_s"> {
  const dv = view(buf);
  let channels: number | null = null;
  let preSkip = 0;
  const head = indexOf(buf, "OpusHead", 0);
  if (head >= 0 && head + 12 <= buf.length) {
    channels = buf[head + 9] ?? null;
    preSkip = dv.getUint16(head + 10, true);
  }
  let last = -1;
  for (let i = buf.length - 27; i >= 0; i--) {
    if (ascii(buf, i, "OggS")) {
      last = i;
      break;
    }
  }
  let duration: number | null = null;
  if (last >= 0) {
    const granule = Number(dv.getBigUint64(last + 6, true));
    if (Number.isFinite(granule) && granule > preSkip)
      duration = round((granule - preSkip) / 48_000);
  }
  return { sample_rate_hz: 48_000, channels, duration_s: duration };
}

function indexOf(buf: Uint8Array, text: string, from: number): number {
  for (let i = from; i <= buf.length - text.length; i++) if (ascii(buf, i, text)) return i;
  return -1;
}

/**
 * Check `bytes` against the requested format. `sampleRate` is the rate asked
 * for (or Fish's default for the format): raw pcm is measured at it since it
 * carries no header, and a container at another rate is reported.
 */
export function checkFishAudio(
  bytes: Uint8Array,
  format: FishTtsFormat,
  sampleRate: number,
): AudioCheck {
  const problems: string[] = [];
  if (bytes.byteLength === 0) {
    return {
      kind: null,
      signature_ok: false,
      sample_rate_hz: null,
      channels: null,
      duration_s: null,
      duration_source: null,
      problems: ["no audio bytes"],
    };
  }
  // Raw pcm can start with any byte, '<' or '{' included; a JSON or HTML body is caught by its content type.
  if (format !== "pcm" && looksLikeText(bytes) && sniffAudioKind(bytes) === undefined) {
    problems.push("the body looks like text (an error page or JSON), not audio");
  }
  const sniffed = sniffAudioKind(bytes, { frameSync: format !== "pcm" });
  const expected = format === "opus" ? "ogg" : format === "pcm" ? undefined : format;
  let kind: string | null = sniffed ?? null;
  let signatureOk: boolean;
  if (format === "pcm") {
    signatureOk = sniffed === undefined && problems.length === 0;
    if (sniffed) problems.push(`asked for raw pcm but got a ${sniffed} container`);
    else kind = "pcm";
    if (bytes.byteLength % 2 !== 0) problems.push("16-bit pcm should have an even byte count");
  } else {
    signatureOk = sniffed === expected;
    if (!signatureOk) {
      problems.push(
        `asked for ${format} but the bytes ${sniffed ? `are ${sniffed}` : "have no known audio header"}`,
      );
    }
  }
  if (format === "opus" && signatureOk && indexOf(bytes, "OpusHead", 0) < 0) {
    signatureOk = false;
    problems.push("the Ogg stream has no OpusHead");
  }

  let info: Pick<AudioCheck, "sample_rate_hz" | "channels" | "duration_s"> = {
    sample_rate_hz: null,
    channels: null,
    duration_s: null,
  };
  let source: AudioCheck["duration_source"] = null;
  if (signatureOk) {
    if (format === "wav") {
      info = wavInfo(bytes);
      source = "header";
    } else if (format === "mp3") {
      info = mp3Info(bytes);
      source = "frames";
    } else if (format === "opus") {
      info = opusInfo(bytes);
      source = "granule";
    } else {
      info = {
        sample_rate_hz: sampleRate,
        channels: 1,
        duration_s: round(bytes.byteLength / (sampleRate * 2)),
      };
      source = "pcm_size";
    }
  }
  if (signatureOk && info.sample_rate_hz !== null && info.sample_rate_hz !== sampleRate) {
    problems.push(`asked for ${sampleRate} Hz but the audio is ${info.sample_rate_hz} Hz`);
  }
  if (signatureOk && info.duration_s !== null && info.duration_s <= 0) {
    problems.push("the audio has no samples");
  }
  return {
    kind,
    signature_ok: signatureOk,
    ...info,
    duration_source: info.duration_s !== null ? source : null,
    problems,
  };
}
