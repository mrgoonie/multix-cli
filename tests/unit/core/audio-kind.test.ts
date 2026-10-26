import { describe, expect, it } from "vitest";
import { audioExtFromMime, looksLikeText, sniffAudioKind } from "../../../src/core/audio-kind.js";

const bytes = (...parts: Array<string | number[]>) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );

describe("sniffAudioKind", () => {
  it("recognises containers by their magic bytes", () => {
    expect(sniffAudioKind(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "))).toBe("wav");
    expect(sniffAudioKind(bytes("OggS", [0, 2]))).toBe("ogg");
    expect(sniffAudioKind(bytes("fLaC", [0]))).toBe("flac");
    expect(sniffAudioKind(bytes([0, 0, 0, 0x20], "ftypM4A "))).toBe("m4a");
    expect(sniffAudioKind(bytes("ID3", [4, 0]))).toBe("mp3");
    expect(sniffAudioKind(bytes([0xff, 0xfb, 0x90, 0x64]))).toBe("mp3");
    expect(sniffAudioKind(bytes([0xff, 0xf1, 0x50, 0x80]))).toBe("aac");
    expect(sniffAudioKind(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
    expect(sniffAudioKind(bytes("FORM", [0, 0, 0, 0], "AIFF"))).toBe("aiff");
  });

  it("returns undefined for headerless raw audio and short or unknown input", () => {
    expect(sniffAudioKind(bytes([0x01, 0x00, 0xfe, 0xff, 0x10]))).toBeUndefined();
    expect(sniffAudioKind(new Uint8Array())).toBeUndefined();
    expect(sniffAudioKind(bytes("RIFF"))).toBeUndefined();
  });

  it("can ignore the frame sync, which raw PCM samples match by chance", () => {
    const pcm = bytes([0xff, 0xff, 0x00, 0x00]);
    expect(sniffAudioKind(pcm)).toBe("mp3");
    expect(sniffAudioKind(pcm, { frameSync: false })).toBeUndefined();
    expect(sniffAudioKind(bytes("ID3", [4]), { frameSync: false })).toBe("mp3");
  });
});

describe("looksLikeText", () => {
  it("flags HTML, JSON and XML bodies, including after a BOM or whitespace", () => {
    expect(looksLikeText(bytes("<!DOCTYPE html>"))).toBe(true);
    expect(looksLikeText(bytes('{"detail":"x"}'))).toBe(true);
    expect(looksLikeText(bytes([0xef, 0xbb, 0xbf], "\n <Error>"))).toBe(true);
    expect(looksLikeText(bytes("RIFF"))).toBe(false);
  });
});

describe("audioExtFromMime", () => {
  it("maps audio MIME types and ignores parameters and case", () => {
    expect(audioExtFromMime("audio/wav")).toBe("wav");
    expect(audioExtFromMime("Audio/MPEG; charset=binary")).toBe("mp3");
    expect(audioExtFromMime("audio/basic")).toBe("ulaw");
    expect(audioExtFromMime("application/octet-stream")).toBeUndefined();
    expect(audioExtFromMime(undefined)).toBeUndefined();
  });
});
