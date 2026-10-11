import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../src/core/errors.js";
import { fetchJson } from "../../../src/core/fetch-json.js";
import { downloadFile } from "../../../src/core/http-client.js";
import {
  fetchFollowingRedirects,
  fetchSameOrigin,
  fetchWithValidatedRedirects,
} from "../../../src/core/redirect-fetch.js";

interface Call {
  url: string;
  init?: RequestInit;
}

/**
 * Fake fetch: answers from `routes` by exact URL and records every request.
 * Unless asked for `redirect: "manual"`, it follows redirects itself with the
 * same init, as fetch does for custom headers.
 */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    const res = route();
    const location = res.headers.get("location");
    if (init?.redirect !== "manual" && location) return fetch(new URL(location, url).href, init);
    return res;
  };
  return { fetch, calls };
}

const redirect = (status: number, location: string) => () =>
  new Response(null, { status, headers: { location } });
const ok =
  (body = "{}") =>
  () =>
    new Response(body, { status: 200 });

/** Header value from a recorded request, whatever form the headers were given in. */
function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init?.headers).get(name);
}

describe("fetchSameOrigin", () => {
  it("follows a same-origin redirect, keeping the key, method and body (307)", async () => {
    const { fetch, calls } = fakeFetch({
      "https://api.test/a": redirect(307, "/b"),
      "https://api.test/b": ok(),
    });
    const res = await fetchSameOrigin(
      "https://api.test/a",
      { method: "POST", headers: { "X-Api-Key": "SECRET" }, body: "payload" },
      fetch,
    );
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["https://api.test/a", "https://api.test/b"]);
    expect(header(calls[1], "x-api-key")).toBe("SECRET");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.body).toBe("payload");
    expect(calls.every((c) => c.init?.redirect === "manual")).toBe(true);
  });

  it.each([
    ["another host", "https://evil.test/steal"],
    ["plain http on the same host", "http://api.test/a"],
    ["another port", "https://api.test:8443/a"],
  ])("does not follow a redirect to %s and returns the 3xx response", async (_, target) => {
    const { fetch, calls } = fakeFetch({ "https://api.test/a": redirect(302, target) });
    const res = await fetchSameOrigin(
      "https://api.test/a",
      { headers: { "x-goog-api-key": "SECRET" } },
      fetch,
    );
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it("switches to a body-less GET on 303 and drops the body headers", async () => {
    const { fetch, calls } = fakeFetch({
      "https://api.test/a": redirect(303, "https://api.test/result"),
      "https://api.test/result": ok(),
    });
    await fetchSameOrigin(
      "https://api.test/a",
      {
        method: "POST",
        headers: { authorization: "Bearer SECRET", "content-type": "application/json" },
        body: "{}",
      },
      fetch,
    );
    expect(calls[1]?.init?.method).toBe("GET");
    expect(calls[1]?.init?.body).toBeUndefined();
    expect(header(calls[1], "content-type")).toBeNull();
    expect(header(calls[1], "authorization")).toBe("Bearer SECRET");
  });

  it("rethrows network errors unchanged", async () => {
    const boom = new TypeError("fetch failed");
    await expect(
      fetchSameOrigin("https://api.test/a", {}, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe("fetchFollowingRedirects", () => {
  it('refuses a cross-origin redirect with crossOrigin: "error"', async () => {
    const { fetch, calls } = fakeFetch({ "https://api.test/a": redirect(301, "https://x.test/") });
    const err = await fetchFollowingRedirects(
      "https://api.test/a",
      { headers: { "X-Api-Key": "SECRET" } },
      { fetch, crossOrigin: "error" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(301);
    expect(err.message).toContain("another origin (https://x.test)");
    expect(calls).toHaveLength(1);
  });

  it("validates a response URL that differs from the requested one", async () => {
    const res = new Response("x");
    Object.defineProperty(res, "url", { value: "http://plain.test/x" });
    const validateUrl = vi.fn((u: string) => {
      if (u.startsWith("http:")) throw new Error("not https");
    });
    await expect(
      fetchFollowingRedirects("https://a.test/x", {}, { fetch: async () => res, validateUrl }),
    ).rejects.toThrow("not https");
    expect(validateUrl).toHaveBeenCalledWith("http://plain.test/x");
  });
});

describe("fetchWithValidatedRedirects with headers only", () => {
  it("follows redirects by hand and drops the key on an origin change", async () => {
    const { fetch, calls } = fakeFetch({
      "https://api.test/file": redirect(302, "https://storage.test/blob?sig=1"),
      "https://storage.test/blob?sig=1": ok("DATA"),
    });
    const { response, url } = await fetchWithValidatedRedirects("https://api.test/file", {
      headers: { "xi-api-key": "SECRET" },
      fetch,
    });
    expect(await response.text()).toBe("DATA");
    expect(url).toBe("https://storage.test/blob?sig=1");
    expect(header(calls[0], "xi-api-key")).toBe("SECRET");
    expect(calls[1]?.init?.headers).toBeUndefined();
    expect(calls.map((c) => c.init?.redirect)).toEqual(["manual", "manual"]);
  });

  it("lets fetch follow redirects itself when there is nothing to protect", async () => {
    const { fetch, calls } = fakeFetch({ "https://a.test/x": ok() });
    await fetchWithValidatedRedirects("https://a.test/x", { fetch });
    expect(calls[0]?.init?.redirect).toBeUndefined();
  });
});

describe("fetchJson redirects", () => {
  it("refuses a redirect to another origin without sending the key there", async () => {
    const { fetch, calls } = fakeFetch({
      "https://api.test/v1/x": redirect(308, "https://evil.test/v1/x"),
    });
    const err = await fetchJson({
      url: "https://api.test/v1/x",
      method: "POST",
      headers: { "X-Api-Key": "SECRET" },
      body: { a: 1 },
      fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(308);
    expect(calls.map((c) => c.url)).toEqual(["https://api.test/v1/x"]);
  });

  it("follows a same-origin redirect", async () => {
    const { fetch, calls } = fakeFetch({
      "https://api.test/v1/x": redirect(301, "/v1/x/"),
      "https://api.test/v1/x/": ok('{"ok":true}'),
    });
    await expect(
      fetchJson({ url: "https://api.test/v1/x", headers: { "X-Api-Key": "K" }, fetch }),
    ).resolves.toEqual({ ok: true });
    expect(header(calls[1], "x-api-key")).toBe("K");
  });
});

describe("downloadFile with key headers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["another origin", "https://storage.test/v.mp4"],
    ["plain http", "http://api.test/v.mp4"],
  ])("never sends the key after a redirect to %s", async (_, target) => {
    const { fetch, calls } = fakeFetch({
      "https://api.test/v.mp4": redirect(302, target),
      [target]: ok("VIDEO"),
    });
    vi.stubGlobal("fetch", fetch);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-redirect-"));
    try {
      await downloadFile("https://api.test/v.mp4", path.join(dir, "v.mp4"), 5_000, {
        "x-goog-api-key": "SECRET",
      });
      expect(fs.readFileSync(path.join(dir, "v.mp4"), "utf8")).toBe("VIDEO");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(header(calls[0], "x-goog-api-key")).toBe("SECRET");
    expect(calls[1]?.url).toBe(target);
    expect(header(calls[1], "x-goog-api-key")).toBeNull();
  });
});
