// Preloaded into a CLI child process: answers speech requests with audio bytes
// derived from the request (equal requests, equal bytes) and logs each call.
import { createHash } from "node:crypto";
import fs from "node:fs";

/** A short valid 24 kHz mono WAV whose samples come from `seed`, so ffprobe can read it. */
function fakeWav(seed) {
  const data = Buffer.alloc(480);
  for (let i = 0; i < data.length; i++) data[i] = seed[i % seed.length];
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const log = process.env.FAKE_FETCH_LOG;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = typeof init?.body === "string" ? init.body : "";
  if (log) fs.appendFileSync(log, `${JSON.stringify({ url })}\n`);
  const digest = createHash("sha256")
    .update(url + body)
    .digest();
  return new Response(fakeWav(digest), {
    status: 200,
    headers: { "content-type": "audio/wav", "character-cost": String(body.length) },
  });
};
