// Preloaded with `node --import` by the CLI smoke tests: answers the npm
// registry's dist-tag lookup for @mrgoonie/multix with FAKE_REGISTRY_VERSION,
// so `multix update --check` runs offline. Every other request goes to the
// real fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://registry.npmjs.org/@mrgoonie/multix/")) {
    return realFetch(input, init);
  }
  return new Response(JSON.stringify({ version: process.env.FAKE_REGISTRY_VERSION }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
