/**
 * Audio checks on Fish TTS output: container signature per requested format,
 * and sample rate, channels and duration read from WAV headers, MP3 frames,
 * Ogg Opus granules and raw PCM size. Fixtures are built in memory.
 */

import { describe, expect, it } from "vitest";
import { checkFishAudio } from "../../../../src/providers/fish/audio-check.js";

function wav(dataBytes: number, rate = 44_100, dataSizeField = dataBytes): Uint8Array {
  const buf = new Uint8Array(44 + dataBytes);
  const dv = new DataView(buf.buffer);
  const put = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  put(8, "WAVE");
  put(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  put(36, "data");
  dv.setUint32(40, dataSizeField, true);
  return buf;
}

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo: 417-byte frames of 1152 samples. */
function mp3(frames: number, id3 = false): Uint8Array {
  const tag = id3 ? [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0] : [];
  const buf = new Uint8Array(tag.length + frames * 417);
  buf.set(tag, 0);
  for (let f = 0; f < frames; f++) buf.set([0xff, 0xfb, 0x90, 0x64], tag.length + f * 417);
  return buf;
}

function oggPage(granule: bigint, payload: Uint8Array): Uint8Array {
  const page = new Uint8Array(27 + 1 + payload.length);
  const dv = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  dv.setBigUint64(6, granule, true);
  page[26] = 1;
  page[27] = payload.length;
  page.set(payload, 28);
  return page;
}

function opus(seconds: number, preSkip = 312): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = 1; // mono
  new DataView(head.buffer).setUint16(10, preSkip, true);
  const first = oggPage(0n, head);
  const last = oggPage(BigInt(seconds * 48_000 + preSkip), new Uint8Array(40));
  const out = new Uint8Array(first.length + last.length);
  out.set(first, 0);
  out.set(last, first.length);
  return out;
}

describe("checkFishAudio", () => {
  it("reads a WAV header", () => {
    expect(checkFishAudio(wav(8820), "wav", 44_100)).toEqual({
      kind: "wav",
      signature_ok: true,
      sample_rate_hz: 44_100,
      channels: 1,
      duration_s: 0.1,
      duration_source: "header",
      problems: [],
    });
  });

  it("measures a streamed WAV whose data size is a placeholder from the bytes present", () => {
    expect(checkFishAudio(wav(4410, 22_050, 0xffffffff), "wav", 44_100).duration_s).toBe(0.1);
  });

  it("walks MP3 frames, after an ID3 tag, to the duration", () => {
    const result = checkFishAudio(mp3(10, true), "mp3", 44_100);
    expect(result).toMatchObject({
      kind: "mp3",
      signature_ok: true,
      sample_rate_hz: 44_100,
      channels: 2,
      duration_s: 0.261,
      duration_source: "frames",
    });
  });

  it("gives no MP3 duration when the frame walk stops early", () => {
    const bytes = new Uint8Array(5000);
    bytes.set(mp3(2), 0);
    const result = checkFishAudio(bytes, "mp3", 44_100);
    expect(result.signature_ok).toBe(true);
    expect(result.duration_s).toBeNull();
    expect(result.duration_source).toBeNull();
  });

  it("reads Opus length from the last granule minus the pre-skip", () => {
    expect(checkFishAudio(opus(1.5), "opus", 48_000)).toMatchObject({
      kind: "ogg",
      signature_ok: true,
      sample_rate_hz: 48_000,
      channels: 1,
      duration_s: 1.5,
      duration_source: "granule",
    });
  });

  it("refuses an Ogg stream without OpusHead", () => {
    const result = checkFishAudio(oggPage(48_000n, new Uint8Array(10)), "opus", 48_000);
    expect(result.signature_ok).toBe(false);
    expect(result.problems).toContain("the Ogg stream has no OpusHead");
  });

  it("sizes raw PCM at the requested rate and refuses a container", () => {
    expect(checkFishAudio(new Uint8Array(88_200), "pcm", 44_100)).toMatchObject({
      kind: "pcm",
      signature_ok: true,
      sample_rate_hz: 44_100,
      duration_s: 1,
      duration_source: "pcm_size",
    });
    const wrapped = checkFishAudio(wav(100), "pcm", 44_100);
    expect(wrapped.signature_ok).toBe(false);
    expect(wrapped.problems.join()).toMatch(/got a wav container/);
    expect(checkFishAudio(new Uint8Array(3), "pcm", 44_100).problems.join()).toMatch(/even/);
  });

  it("refuses the wrong container, a text body and no bytes", () => {
    expect(checkFishAudio(wav(100), "mp3", 44_100)).toMatchObject({
      signature_ok: false,
      kind: "wav",
      problems: ["asked for mp3 but the bytes are wav"],
    });
    const text = checkFishAudio(new TextEncoder().encode('{"message":"x"}'), "mp3", 44_100);
    expect(text.signature_ok).toBe(false);
    expect(text.problems.join()).toMatch(/looks like text/);
    expect(checkFishAudio(new Uint8Array(0), "wav", 44_100).problems).toEqual(["no audio bytes"]);
  });

  it("warns when the audio rate is not the rate that was asked for", () => {
    const result = checkFishAudio(wav(4410, 22_050), "wav", 44_100);
    expect(result.signature_ok).toBe(true);
    expect(result.problems).toEqual(["asked for 44100 Hz but the audio is 22050 Hz"]);
    expect(checkFishAudio(wav(8820), "wav", 44_100).problems).toEqual([]);
  });

  it("accepts raw PCM whose first bytes look like text", () => {
    const pcm = new Uint8Array(200).fill(0x20);
    pcm[0] = 0x5b; // "["
    const result = checkFishAudio(pcm, "pcm", 16_000);
    expect(result.signature_ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("does not count a Xing header frame as audio", () => {
    const bytes = mp3(11);
    bytes.set(new TextEncoder().encode("Xing"), 36);
    expect(checkFishAudio(bytes, "mp3", 44_100).duration_s).toBe(0.261);
  });
});
