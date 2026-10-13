import { describe, expect, it } from "vitest";
import { checkR2Access } from "../src/storage/r2-access-check.js";
import {
  MAX_PRESIGN_SECONDS,
  R2Client,
  R2RequestError,
  publicObjectUrl,
} from "../src/storage/r2-client.js";
import { mockFetch, route } from "./helpers.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ACCESS_KEY_ID = "AKIDEXAMPLE0123456789";
const SECRET = "r2-secret-access-key-0123456789abcdef";
const HOST = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const CREDS = { accountId: ACCOUNT_ID, accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET };

const xmlError = (status: number, code: string) =>
  new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>m</Message></Error>`, {
    status,
  });

describe("R2Client", () => {
  it("signs a path-style PUT with SigV4 for region auto and service s3", async () => {
    const r2 = mockFetch(route("PUT", /\.r2\.cloudflarestorage\.com\//, () => new Response(null)));
    const client = new R2Client({ ...CREDS, fetch: r2.fetch });
    await client.putObject("my-bucket", "multix/u 1/out+1.png", "data", "image/png");
    const call = r2.calls[0];
    expect(call?.url).toBe(`${HOST}/my-bucket/multix/u%201/out%2B1.png`);
    expect(call?.headers.authorization).toMatch(
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/\\d{8}/auto/s3/aws4_request, `),
    );
    expect(call?.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(call?.headers["content-type"]).toBe("image/png");
    expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("lists one key to prove read access", async () => {
    const r2 = mockFetch(route("GET", /./, () => new Response("<ListBucketResult/>")));
    await new R2Client({ ...CREDS, fetch: r2.fetch }).listProbe("my-bucket");
    expect(r2.calls[0]?.url).toBe(`${HOST}/my-bucket?list-type=2&max-keys=1`);
  });

  it("presigns GET links for at most 7 days", async () => {
    const client = new R2Client(CREDS);
    const url = new URL(await client.presignGet("my-bucket", "a/b.mp4"));
    expect(url.origin + url.pathname).toBe(`${HOST}/my-bucket/a/b.mp4`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(MAX_PRESIGN_SECONDS));
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toContain(`${ACCESS_KEY_ID}/`);
    expect(url.toString()).not.toContain(SECRET);
    const clamped = new URL(await client.presignGet("my-bucket", "a/b.mp4", 10_000_000));
    expect(clamped.searchParams.get("X-Amz-Expires")).toBe("604800");
    const short = new URL(await client.presignGet("my-bucket", "a/b.mp4", 60));
    expect(short.searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("rejects account ids, buckets and keys that could change the host or path", () => {
    expect(() => new R2Client({ ...CREDS, accountId: "evil.example.com#" })).toThrow(
      "Invalid R2 account id",
    );
    const client = new R2Client(CREDS);
    expect(() => client.objectUrl("../other", "k")).toThrow("Invalid R2 bucket name");
    expect(() => client.objectUrl("my-bucket", "")).toThrow("Invalid R2 object key");
    expect(() => client.objectUrl("my-bucket", "/abs")).toThrow("Invalid R2 object key");
    expect(() => client.objectUrl("my-bucket", "x".repeat(1025))).toThrow("Invalid R2 object key");
  });

  it("reports the status and S3 code without the URL or credentials", async () => {
    const r2 = mockFetch(route("PUT", /./, () => xmlError(403, "AccessDenied")));
    const error = await new R2Client({ ...CREDS, fetch: r2.fetch })
      .putObject("my-bucket", "k", "x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2RequestError);
    expect((error as R2RequestError).status).toBe(403);
    expect((error as R2RequestError).code).toBe("AccessDenied");
    expect((error as Error).message).toBe("R2 upload failed: HTTP 403 AccessDenied");

    const offline = mockFetch(() => {
      throw new TypeError(`fetch failed for ${HOST}/my-bucket/k`);
    });
    const unreachable = await new R2Client({ ...CREDS, fetch: offline.fetch })
      .deleteObject("my-bucket", "k")
      .catch((e: unknown) => e);
    expect((unreachable as R2RequestError).status).toBe(0);
    expect((unreachable as Error).message).not.toContain(HOST);
  });

  it("builds public URLs under an optional base URL", () => {
    expect(publicObjectUrl("https://media.example.com/out/", "a b/c.png")).toBe(
      "https://media.example.com/out/a%20b/c.png",
    );
    expect(publicObjectUrl(undefined, "a.png")).toBeUndefined();
  });
});

describe("checkR2Access", () => {
  const settings = { ...CREDS, bucket: "my-bucket" };

  function r2With(list: number, put: number, del: number) {
    return mockFetch(
      route("GET", /list-type=2/, () =>
        list === 200 ? new Response("<ListBucketResult/>") : xmlError(list, "Err"),
      ),
      route("PUT", /\/\.multix-probe$/, () => new Response(null, { status: put })),
      route("DELETE", /\/\.multix-probe$/, () => new Response(null, { status: del })),
    );
  }

  it("lists, writes and deletes an empty probe object", async () => {
    const r2 = r2With(200, 200, 204);
    expect(await checkR2Access(settings, r2.fetch)).toBe("ok");
    expect(r2.calls.map((c) => c.method)).toEqual(["GET", "PUT", "DELETE"]);
  });

  it.each([
    [[403, 200, 204], "denied"],
    [[401, 200, 204], "denied"],
    [[404, 200, 204], "no-bucket"],
    [[500, 200, 204], "error"],
    [[200, 403, 204], "read-only"],
    [[200, 200, 403], "no-delete"],
    [[200, 500, 204], "error"],
  ] as const)("maps %j to %s", async ([list, put, del], expected) => {
    expect(await checkR2Access(settings, r2With(list, put, del).fetch)).toBe(expected);
  });

  it("reports an unreachable endpoint", async () => {
    const offline = mockFetch(() => {
      throw new TypeError("network down");
    });
    expect(await checkR2Access(settings, offline.fetch)).toBe("unreachable");
  });
});
