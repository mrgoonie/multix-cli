// Preloaded with `node --import` by the agent-mode smoke tests: serves every
// https://cdn.multix.example/ URL as a small PNG, so a status --download run
// saves real files without leaving the machine. Every other request goes to
// the real fetch (the loopback fake API).
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://cdn.multix.example/")) return realFetch(input, init);
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
};
