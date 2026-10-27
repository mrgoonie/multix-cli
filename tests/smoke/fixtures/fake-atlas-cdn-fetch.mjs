// Preloaded with `node --import` by the agent-mode smoke tests: serves Atlas
// output URLs on https://cdn.atlas.example/ as a download that starts and never
// finishes, and writes FAKE_CDN_MARKER once the CLI has taken the first chunk
// and asks for more (its lock and temp file exist by then).
// Every other request goes to the real fetch (the loopback fake API).
import fs from "node:fs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://cdn.atlas.example/")) return realFetch(input, init);
  let sent = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        return;
      }
      fs.writeFileSync(process.env.FAKE_CDN_MARKER, "started");
      // A stalled socket keeps the process alive; a bare pending promise would not.
      setInterval(() => {}, 1_000);
      return new Promise(() => {});
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
};
