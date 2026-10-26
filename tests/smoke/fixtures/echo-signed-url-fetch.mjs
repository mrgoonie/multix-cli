// Preloaded with `node --import` by smoke tests: every fetch answers HTTP 400
// with an OpenRouter-style error that echoes a pre-signed URL, as a provider
// does when it cannot download an input, and first logs that raw body to
// stderr, as some commands do. No request leaves the machine.
const SIGNED =
  "https://bucket.s3.amazonaws.com/talk.m4a?X-Amz-Signature=SMOKESECRET&X-Amz-Expires=60";

globalThis.fetch = async () => {
  const body = JSON.stringify({ error: { message: `failed to download ${SIGNED}`, code: 400 } });
  process.stderr.write(`provider body: ${body}\n`);
  return new Response(body, { status: 400, headers: { "content-type": "application/json" } });
};
