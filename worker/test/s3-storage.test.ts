import { describe, expect, it } from "vitest";
import { linkExpirySeconds, parseR2Settings } from "../src/accounts/r2-settings.js";
import { outputLinkMaxSecondsFrom } from "../src/config.js";
import { checkR2Access } from "../src/storage/r2-access-check.js";
import { R2Client, normaliseEndpoint, resolveTarget } from "../src/storage/r2-client.js";
import { jsonResponse, mockFetch, route } from "./helpers.js";

const ACCESS_KEY_ID = "AKIDEXAMPLE0123456789";
const SECRET = "s3-secret-access-key-0123456789abcdef";
const ENDPOINT = "https://s3.eu-central-1.amazonaws.com";
const CREDS = {
  endpoint: ENDPOINT,
  region: "eu-central-1",
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET,
};

/** DNS-over-HTTPS: names starting with `private` resolve to 10.0.0.1, `nx` to nothing, others to a public address. */
const dns = route("GET", /^https:\/\/cloudflare-dns\.com\/dns-query\?/, (call) => {
  const url = new URL(call.url);
  const name = url.searchParams.get("name") ?? "";
  if (name.startsWith("dnsfail")) return jsonResponse({ Status: 2 });
  if (name.startsWith("nx")) return jsonResponse({ Status: 3 });
  if (url.searchParams.get("type") !== "A") return jsonResponse({ Status: 0, Answer: [] });
  const data = name.startsWith("private") || name.includes(".private-") ? "10.0.0.1" : "3.5.1.1";
  return jsonResponse({ Status: 0, Answer: [{ type: 1, data }] });
});

const ok = () => new Response(null, { status: 200 });

describe("S3-compatible endpoint client", () => {
  it("signs a path-style PUT with SigV4 for the endpoint's region", async () => {
    const s3 = mockFetch(route("PUT", /./, ok));
    const client = new R2Client({ ...CREDS, fetch: s3.fetch });
    await client.putObject("my-bucket", "multix/a b.png", "data", "image/png");
    const call = s3.calls[0];
    expect(call?.url).toBe(`${ENDPOINT}/my-bucket/multix/a%20b.png`);
    expect(call?.headers.authorization).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/\\d{8}/eu-central-1/s3/aws4_request, SignedHeaders=[^,]*host`,
      ),
    );
    expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("uses virtual-hosted bucket URLs and signs the bucket host", async () => {
    const s3 = mockFetch(
      route("GET", /./, () => new Response("<ListBucketResult/>")),
      route("PUT", /./, ok),
    );
    const client = new R2Client({ ...CREDS, addressing: "virtual", fetch: s3.fetch });
    await client.listProbe("my-bucket");
    await client.putObject("my-bucket", "k.txt", "x");
    expect(s3.calls[0]?.url).toBe(
      "https://my-bucket.s3.eu-central-1.amazonaws.com/?list-type=2&max-keys=1",
    );
    expect(s3.calls[1]?.url).toBe("https://my-bucket.s3.eu-central-1.amazonaws.com/k.txt");
    const presigned = new URL(await client.presignGet("my-bucket", "k.txt", 3600));
    expect(presigned.host).toBe("my-bucket.s3.eu-central-1.amazonaws.com");
    expect(presigned.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(presigned.searchParams.get("X-Amz-Credential")).toMatch(
      /\/eu-central-1\/s3\/aws4_request$/,
    );
  });

  it("defaults a custom endpoint to region us-east-1 and path-style", () => {
    expect(resolveTarget({ endpoint: "https://minio.example.com" })).toEqual({
      origin: "https://minio.example.com",
      region: "us-east-1",
      addressing: "path",
      r2: false,
    });
  });

  it("allows dotted bucket names only with path-style on a custom endpoint", () => {
    const path = new R2Client(CREDS);
    expect(path.objectUrl("media.example.com", "k")).toBe(`${ENDPOINT}/media.example.com/k`);
    const virtual = new R2Client({ ...CREDS, addressing: "virtual" });
    expect(() => virtual.objectUrl("media.example.com", "k")).toThrow("Invalid bucket name");
    for (const bucket of ["a..b", "192.168.1.1", ".abc", "ab"]) {
      expect(() => path.objectUrl(bucket, "k")).toThrow("Invalid bucket name");
    }
  });

  it("refuses endpoints that are not a public https origin by host name", () => {
    for (const raw of [
      "http://s3.example.com",
      "https://10.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://minio.internal",
      "https://metadata.google.internal",
      "https://s3.example.com:9000",
      "https://s3.example.com/bucket",
      "https://s3.example.com/?x=1",
      "https://user:pw@s3.example.com",
      "https://singlelabel",
      "not a url",
    ]) {
      expect(normaliseEndpoint(raw), raw).toBeUndefined();
    }
    expect(normaliseEndpoint(" https://S3.Example.com/ ")).toBe("https://s3.example.com");
    expect(() => new R2Client({ ...CREDS, endpoint: "https://10.0.0.1" })).toThrow(
      "Invalid storage endpoint",
    );
    expect(
      () =>
        new R2Client({
          ...CREDS,
          accountId: "0123456789abcdef0123456789abcdef",
        }),
    ).toThrow("not both");
  });
});

describe("storage access check against an endpoint", () => {
  it("checks that the endpoint is public, then lists, uploads and deletes", async () => {
    const s3 = mockFetch(
      dns,
      route("GET", /^https:\/\/s3\.eu-central-1\.amazonaws\.com\/my-bucket\?list-type=2/, ok),
      route("PUT", /\/my-bucket\/out\/\.multix-probe-/, ok),
      route("DELETE", /\/my-bucket\/out\/\.multix-probe-/, ok),
    );
    const result = await checkR2Access({ ...CREDS, bucket: "my-bucket" }, s3.fetch, "out");
    expect(result).toBe("ok");
    expect(s3.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "PUT", "DELETE"]);
    expect(s3.calls[0]?.url).toContain("name=s3.eu-central-1.amazonaws.com");
  });

  it("checks the bucket host when virtual-hosted", async () => {
    const s3 = mockFetch(dns);
    const result = await checkR2Access(
      {
        ...CREDS,
        endpoint: "https://store.example.com",
        addressing: "virtual",
        bucket: "private-x",
      },
      s3.fetch,
    );
    // private-x.store.example.com resolves to 10.0.0.1: nothing reaches the bucket.
    expect(result).toBe("endpoint-not-public");
    expect(s3.calls.every((c) => c.url.startsWith("https://cloudflare-dns.com/"))).toBe(true);
    expect(s3.calls[0]?.url).toContain("name=private-x.store.example.com");
  });

  it.each([
    ["https://private.example.com", "endpoint-not-public"],
    ["https://nx.example.com", "endpoint-not-public"],
    ["https://dnsfail.example.com", "unreachable"],
  ])("refuses %s before any S3 request (%s)", async (endpoint, expected) => {
    const s3 = mockFetch(dns);
    const result = await checkR2Access({ ...CREDS, endpoint, bucket: "my-bucket" }, s3.fetch);
    expect(result).toBe(expected);
    expect(s3.calls.every((c) => c.url.startsWith("https://cloudflare-dns.com/"))).toBe(true);
  });

  it("does not resolve the fixed R2 account endpoint (unchanged R2 behaviour)", async () => {
    const r2 = mockFetch(
      route("GET", /list-type=2/, ok),
      route("PUT", /./, ok),
      route("DELETE", /./, ok),
    );
    const result = await checkR2Access(
      {
        accountId: "0123456789abcdef0123456789abcdef",
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET,
        bucket: "my-bucket",
      },
      r2.fetch,
    );
    expect(result).toBe("ok");
    expect(r2.calls.map((c) => new URL(c.url).host)).toEqual(
      Array(3).fill("0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"),
    );
  });
});

describe("storage settings parsing", () => {
  const base = {
    accountId: "",
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET,
    bucket: "my-bucket",
    publicBaseUrl: "",
  };

  it("accepts an endpoint with region, addressing and link lifetime", () => {
    expect(
      parseR2Settings({
        ...base,
        endpoint: " https://S3.eu-central-1.amazonaws.com/ ",
        region: "EU-Central-1",
        addressing: "virtual",
        linkExpirySeconds: "3600",
      }),
    ).toEqual({
      ok: true,
      settings: {
        endpoint: ENDPOINT,
        region: "eu-central-1",
        addressing: "virtual",
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET,
        bucket: "my-bucket",
        linkExpirySeconds: 3600,
      },
    });
  });

  it("keeps the R2 record shape unchanged", () => {
    expect(
      parseR2Settings({
        ...base,
        accountId: "0123456789ABCDEF0123456789ABCDEF",
        addressing: "path",
        linkExpirySeconds: "604800",
      }),
    ).toEqual({
      ok: true,
      settings: {
        accountId: "0123456789abcdef0123456789abcdef",
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET,
        bucket: "my-bucket",
      },
    });
  });

  it.each([
    [{}, "account"],
    [{ accountId: "0123456789abcdef0123456789abcdef", endpoint: ENDPOINT }, "account"],
    [{ endpoint: "https://192.168.0.10" }, "endpoint"],
    [{ endpoint: "https://minio.local" }, "endpoint"],
    [{ endpoint: ENDPOINT, region: "eu central" }, "region"],
    [{ accountId: "0123456789abcdef0123456789abcdef", region: "us-east-1" }, "region"],
    [{ endpoint: ENDPOINT, addressing: "dns" }, "addressing"],
    [{ accountId: "0123456789abcdef0123456789abcdef", addressing: "virtual" }, "addressing"],
    [{ endpoint: ENDPOINT, addressing: "virtual", bucket: "a.b.c" }, "bucket"],
    [{ accountId: "0123456789abcdef0123456789abcdef", bucket: "a.b.c" }, "bucket"],
    [{ endpoint: ENDPOINT, linkExpirySeconds: "59" }, "expiry"],
    [{ endpoint: ENDPOINT, linkExpirySeconds: "604801" }, "expiry"],
    [{ endpoint: ENDPOINT, linkExpirySeconds: "1.5" }, "expiry"],
    [{ endpoint: ENDPOINT, linkExpirySeconds: "invalid" }, "expiry"],
  ])("rejects %j as %s", (overrides, problem) => {
    expect(parseR2Settings({ ...base, ...overrides })).toEqual({ ok: false, problem });
  });

  it("caps the account's link lifetime with the operator's", () => {
    const settings = { ...base, endpoint: ENDPOINT, linkExpirySeconds: 86_400 };
    expect(linkExpirySeconds(settings)).toBe(86_400);
    expect(linkExpirySeconds(settings, 3_600)).toBe(3_600);
    expect(linkExpirySeconds({ ...settings, linkExpirySeconds: undefined })).toBe(604_800);
  });

  it("reads the operator cap from MULTIX_OUTPUT_LINK_MAX_SECONDS", () => {
    const cap = (value?: string) =>
      outputLinkMaxSecondsFrom({ MULTIX_OUTPUT_LINK_MAX_SECONDS: value } as never);
    expect(cap()).toBe(604_800);
    expect(cap("3600")).toBe(3_600);
    expect(cap("30")).toBe(60);
    expect(cap("99999999")).toBe(604_800);
    expect(cap("abc")).toBe(604_800);
  });
});

describe("job spec link lifetime", () => {
  it("sends the account's link lifetime under the operator cap", async () => {
    const { jobsContextFor } = await import("../src/jobs/job-context.js");
    const saved = {
      endpoint: ENDPOINT,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      bucket: "my-bucket",
      linkExpirySeconds: 86_400,
    };
    const contextFor = (cap: string | undefined, settings: object | null) =>
      jobsContextFor(
        {
          MULTIX_JOBS: {},
          MULTIX_JOB_QUOTA: {},
          ACCOUNTS_KV: {},
          MULTIX_OUTPUT_LINK_MAX_SECONDS: cap,
        } as never,
        { accounts: { r2Settings: async () => settings } } as never,
        "user-1",
        {},
        { jobBackend: {} } as never,
      );
    expect(await contextFor("3600", saved)?.r2Settings()).toEqual({
      ...saved,
      linkExpirySeconds: 3_600,
    });
    expect(await contextFor(undefined, saved)?.r2Settings()).toEqual(saved);
    const { linkExpirySeconds: _unset, ...noChoice } = saved;
    expect(await contextFor(undefined, noChoice)?.r2Settings()).toEqual(noChoice);
    expect(await contextFor(undefined, null)?.r2Settings()).toBeNull();
  });
});
