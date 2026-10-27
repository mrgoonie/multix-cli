/**
 * The length a WAV file's header declares for its sample data, compared with
 * the bytes the file actually holds. ffprobe sizes a WAV from the bytes that
 * are present, so a file cut on a sample boundary decodes cleanly and only its
 * `data` chunk header still says how long it should be.
 */

import fs from "node:fs";

export interface WavDataLength {
  /** Sample bytes the `data` chunk header declares. */
  declared_bytes: number;
  /** Sample bytes the file holds after the chunk header. */
  present_bytes: number;
  truncated: boolean;
}

/** Chunk headers walked before giving up on finding `data`. */
const MAX_CHUNKS = 64;
/**
 * 32-bit sizes a writer puts in the header when it does not know the length (a piped or
 * streamed WAV): 0, 0xFFFFFFFF, and 0x7FFFF000 (written by SoX and some streaming servers).
 */
const PLACEHOLDER_SIZES = new Set([0, 0xffffffff, 0x7ffff000]);
const RIFF_MAGIC = new Set(["RIFF", "RIFX", "RF64"]);

/** Whether a file's first bytes name a RIFF, RIFX or RF64 WAVE. */
export function looksLikeWave(head: Buffer): boolean {
  return (
    head.length >= 12 &&
    RIFF_MAGIC.has(head.toString("latin1", 0, 4)) &&
    head.toString("latin1", 8, 12) === "WAVE"
  );
}

/**
 * Reads the declared `data` length of a RIFF, RIFX or RF64 WAVE file. Null when
 * the file is not a WAVE, the header declares no length, or `data` is not found.
 * A file is truncated only when both the `data` chunk and the RIFF size declare
 * more bytes than it holds, so a writer that miscounts one of them does not fail
 * a complete file.
 */
export async function readWavDataLength(file: string): Promise<WavDataLength | null> {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size } = await fh.stat();
    const read = async (offset: number, length: number): Promise<Buffer | null> => {
      if (offset + length > size) return null;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return bytesRead === length ? buf : null;
    };
    const head = await read(0, 12);
    if (!head || !looksLikeWave(head)) return null;
    const magic = head.toString("latin1", 0, 4);
    const u32 = (b: Buffer, at: number) =>
      magic === "RIFX" ? b.readUInt32BE(at) : b.readUInt32LE(at);
    const known = (n: number | null) => (n === null || PLACEHOLDER_SIZES.has(n) ? null : n);

    let riffSize = magic === "RF64" ? null : known(u32(head, 4));
    let ds64DataSize: number | null = null;
    let offset = 12;
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const header = await read(offset, 8);
      if (!header) return null;
      const id = header.toString("latin1", 0, 4);
      const chunkSize = u32(header, 4);
      if (id === "ds64" && magic === "RF64" && chunkSize >= 16) {
        // RF64 keeps its 64-bit sizes in ds64: riffSize, then dataSize.
        const body = await read(offset + 8, 16);
        if (!body) return null;
        const safe = (n: bigint) => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null);
        riffSize = known(safe(body.readBigUInt64LE(0)));
        ds64DataSize = known(safe(body.readBigUInt64LE(8)));
      }
      if (id === "data") {
        const declared = known(
          magic === "RF64" && chunkSize === 0xffffffff ? ds64DataSize : chunkSize,
        );
        if (declared === null) return null;
        const present = size - (offset + 8);
        return {
          declared_bytes: declared,
          present_bytes: present,
          truncated: present < declared && (riffSize === null || riffSize + 8 > size),
        };
      }
      // Chunks are padded to an even length.
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    return null;
  } finally {
    await fh.close();
  }
}
