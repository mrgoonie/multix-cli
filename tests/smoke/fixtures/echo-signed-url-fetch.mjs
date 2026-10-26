// Preloaded with `node --import` by smoke tests: every fetch answers HTTP 400
// with an OpenRouter-style error that echoes a pre-signed URL, as a provider
// does when it cannot download an input. No request leaves the machine.
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      error: {
        message:
          "failed to download https://bucket.s3.amazonaws.com/talk.m4a?X-Amz-Signature=SMOKESECRET&X-Amz-Expires=60",
        code: 400,
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
