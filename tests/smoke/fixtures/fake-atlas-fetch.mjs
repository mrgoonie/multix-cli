// Preloaded with `node --import` by the budget smoke tests: answers Atlas Cloud
// like the real API. A submit returns a processing prediction; reading it
// returns the finished prediction with the charged price as `data.price`
// (a decimal string) and `data.credits_consumed`, as Atlas does for 3D runs.
const BASE = "https://api.atlascloud.ai/api/v1";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = String(init.method ?? (input instanceof Request ? input.method : "GET"));
  if (!url.startsWith(`${BASE}/`)) throw new TypeError(`unexpected fetch ${url}`);
  const path = new URL(url).pathname.slice("/api/v1".length);
  if (method === "POST" && path.startsWith("/model/generate")) {
    return json({ code: 200, data: { id: "pred-3d-1", status: "processing" } });
  }
  if (method === "GET" && path === "/model/prediction/pred-3d-1") {
    return json({
      code: 200,
      data: {
        id: "pred-3d-1",
        model: "meshy-v7/multi-image-to-3d",
        status: "completed",
        outputs: ["https://cdn.test/out/model.glb"],
        error: "",
        price: "0.66",
        credits_consumed: 30,
      },
    });
  }
  // Model list and price list: nothing listed, so no list price applies.
  if (method === "GET" && (path === "/models" || path === "/pricing/models")) {
    return json({ code: 200, data: [] });
  }
  return json({ code: 404, message: `no route ${method} ${path}` }, 404);
};
