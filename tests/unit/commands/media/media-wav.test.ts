import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readWavDataLength } from "../../../../src/commands/media/media-wav.js";

let dir: string;

function chunk(id: string, body: Buffer, bigEndian = false, size = body.length): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, "latin1");
  if (bigEndian) head.writeUInt32BE(size, 4);
  else head.writeUInt32LE(size, 4);
  return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function wav(opts: {
  magic?: "RIFF" | "RIFX" | "RF64";
  form?: string;
  before?: Buffer[];
  dataSize: number;
  dataBytes: number;
  ds64?: number;
  /** RIFF size in the file header; the default 0xFFFFFFFF declares none. */
  riffSize?: number;
}): Buffer {
  const magic = opts.magic ?? "RIFF";
  const bigEndian = magic === "RIFX";
  const fmt = chunk("fmt ", Buffer.alloc(16), bigEndian);
  const ds64 =
    opts.ds64 === undefined
      ? []
      : [
          (() => {
            const body = Buffer.alloc(28);
            body.writeBigUInt64LE(BigInt(opts.ds64), 8);
            return chunk("ds64", body);
          })(),
        ];
  const dataHead = Buffer.alloc(8);
  dataHead.write("data", 0, "latin1");
  if (bigEndian) dataHead.writeUInt32BE(opts.dataSize, 4);
  else dataHead.writeUInt32LE(opts.dataSize, 4);
  const header = Buffer.alloc(12);
  header.write(magic, 0, "latin1");
  header.writeUInt32LE(opts.riffSize ?? 0xffffffff, 4);
  header.write(opts.form ?? "WAVE", 8, "latin1");
  return Buffer.concat([
    header,
    ...ds64,
    fmt,
    ...(opts.before ?? []),
    dataHead,
    Buffer.alloc(opts.dataBytes),
  ]);
}

async function lengthOf(name: string, bytes: Buffer) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return readWavDataLength(file);
}

describe("readWavDataLength", () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-wav-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a complete WAV as not truncated", async () => {
    expect(await lengthOf("ok.wav", wav({ dataSize: 4000, dataBytes: 4000 }))).toEqual({
      declared_bytes: 4000,
      present_bytes: 4000,
      truncated: false,
    });
  });

  it("flags a WAV that holds fewer sample bytes than its data chunk declares", async () => {
    expect(await lengthOf("cut.wav", wav({ dataSize: 4000, dataBytes: 1000 }))).toEqual({
      declared_bytes: 4000,
      present_bytes: 1000,
      truncated: true,
    });
  });

  it("walks past other chunks, including odd-sized ones with a pad byte", async () => {
    const list = chunk("LIST", Buffer.from("INFOabc", "latin1"));
    const big = chunk("bext", Buffer.alloc(6000));
    const r = await lengthOf(
      "chunks.wav",
      wav({ before: [list, big], dataSize: 4000, dataBytes: 3998 }),
    );
    expect(r).toMatchObject({ declared_bytes: 4000, present_bytes: 3998, truncated: true });
  });

  it("does not count trailing chunks after the samples as missing data", async () => {
    const r = await lengthOf(
      "trailer.wav",
      Buffer.concat([wav({ dataSize: 100, dataBytes: 100 }), chunk("LIST", Buffer.alloc(20))]),
    );
    expect(r).toMatchObject({ truncated: false, declared_bytes: 100, present_bytes: 100 });
  });

  it("reads big-endian RIFX sizes", async () => {
    expect(
      await lengthOf("be.wav", wav({ magic: "RIFX", dataSize: 4000, dataBytes: 10 })),
    ).toMatchObject({ declared_bytes: 4000, truncated: true });
  });

  it("reads the RF64 data size from ds64", async () => {
    const r = await lengthOf(
      "rf64.wav",
      wav({ magic: "RF64", ds64: 5000, dataSize: 0xffffffff, dataBytes: 2000 }),
    );
    expect(r).toMatchObject({ declared_bytes: 5000, present_bytes: 2000, truncated: true });
  });

  it("keeps RF64 sizes from 2 GiB up as real lengths", async () => {
    const r = await lengthOf(
      "rf64-big.wav",
      wav({ magic: "RF64", ds64: 0x80000000, dataSize: 0xffffffff, dataBytes: 2000 }),
    );
    expect(r).toMatchObject({ declared_bytes: 0x80000000, present_bytes: 2000, truncated: true });
  });

  it("does not fail a complete file whose data size alone is miscounted", async () => {
    const complete = wav({ dataSize: 4008, dataBytes: 4000 });
    complete.writeUInt32LE(complete.length - 8, 4);
    expect(await lengthOf("miscount.wav", complete)).toMatchObject({
      declared_bytes: 4008,
      present_bytes: 4000,
      truncated: false,
    });
    // The same header cut short: the RIFF size now exceeds the file as well.
    expect(await lengthOf("miscount-cut.wav", complete.subarray(0, 2000))).toMatchObject({
      truncated: true,
    });
  });

  it("returns null when the header declares no length (piped WAV)", async () => {
    expect(await lengthOf("sox.wav", wav({ dataSize: 0x7ffff000, dataBytes: 100 }))).toBeNull();
    expect(await lengthOf("pipe.wav", wav({ dataSize: 0xffffffff, dataBytes: 100 }))).toBeNull();
    expect(await lengthOf("zero.wav", wav({ dataSize: 0, dataBytes: 100 }))).toBeNull();
    // GStreamer wavenc on a pipe: data 0x7FFF0000, RIFF size that plus the header.
    expect(
      await lengthOf(
        "gst.wav",
        wav({ dataSize: 0x7fff0000, riffSize: 0x7fff0000 + 36, dataBytes: 100 }),
      ),
    ).toBeNull();
  });

  it("returns null for other RIFF forms, other files and a header cut before data", async () => {
    expect(await lengthOf("x.avi", wav({ form: "AVI ", dataSize: 10, dataBytes: 1 }))).toBeNull();
    expect(await lengthOf("x.mp3", Buffer.from("ID3\u0004\u0000\u0000\u0000"))).toBeNull();
    expect(
      await lengthOf("short.wav", wav({ dataSize: 10, dataBytes: 0 }).subarray(0, 30)),
    ).toBeNull();
    expect(await lengthOf("empty.wav", Buffer.alloc(0))).toBeNull();
  });
});
