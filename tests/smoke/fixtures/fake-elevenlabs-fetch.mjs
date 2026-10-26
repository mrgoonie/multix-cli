// Preloaded with `node --import` by the budget smoke tests: answers ElevenLabs
// text-to-speech requests locally, like the real API, including the
// character-cost header. FAKE_ELEVENLABS_STATUS makes the submit fail instead.
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.elevenlabs.io/")) throw new TypeError(`unexpected fetch ${url}`);
  const status = Number(process.env.FAKE_ELEVENLABS_STATUS ?? 200);
  if (status !== 200) {
    return new Response(JSON.stringify({ detail: { message: "fake failure" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  const body = JSON.parse(String(init.body ?? "{}"));
  const billed = [...String(body.text ?? "")].length;
  return new Response(new Uint8Array([0xff, 0xf3, 0x44, 0xc4]), {
    status: 200,
    headers: { "content-type": "audio/mpeg", "character-cost": String(billed) },
  });
};
