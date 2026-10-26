// Preloaded into a CLI child process: answers speech requests with audio bytes
// derived from the request (equal requests, equal bytes) and logs each call.
import { createHash } from "node:crypto";
import fs from "node:fs";

const log = process.env.FAKE_FETCH_LOG;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = typeof init?.body === "string" ? init.body : "";
  if (log) fs.appendFileSync(log, `${JSON.stringify({ url })}\n`);
  const digest = createHash("sha256")
    .update(url + body)
    .digest();
  return new Response(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), digest]), {
    status: 200,
    headers: { "content-type": "audio/mpeg", "character-cost": String(body.length) },
  });
};
