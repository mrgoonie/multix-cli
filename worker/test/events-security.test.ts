import { describe, expect, it } from "vitest";
import {
  CallbackDnsError,
  CallbackUrlError,
  assertPublicCallbackUrl,
  isNonPublicIpv4,
  isNonPublicIpv6,
} from "../src/events/callback-guard.js";
import { verifyCallback } from "../src/events/callback-verification.js";
import { canonicalJson, subscriptionId } from "../src/events/subscription-identity.js";
import { isValidSecret, signWebhook, webhookHeaders } from "../src/events/webhook-signing.js";
import { dohRoute } from "./events-helpers.js";
import { jsonResponse, mockFetch, route } from "./helpers.js";

const SECRET = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;

describe("webhook signing", () => {
  it("matches the Standard Webhooks reference signature", async () => {
    const signature = await signWebhook(
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      1614265330,
      '{"test": 2432232314}',
    );
    expect(signature).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("accepts only whsec_ secrets of 24-64 bytes", () => {
    expect(isValidSecret(SECRET)).toBe(true);
    expect(isValidSecret(`whsec_${Buffer.alloc(16).toString("base64")}`)).toBe(false);
    expect(isValidSecret(`whsec_${Buffer.alloc(65).toString("base64")}`)).toBe(false);
    expect(isValidSecret(Buffer.alloc(32).toString("base64"))).toBe(false);
    expect(isValidSecret("whsec_not base64!")).toBe(false);
  });

  it("signs with every secret of a rotation window", async () => {
    const other = `whsec_${Buffer.alloc(24, 1).toString("base64")}`;
    const headers = await webhookHeaders([SECRET, other], "msg_1", 10, "{}", "sub_x");
    expect(headers["webhook-signature"]?.split(" ")).toEqual([
      await signWebhook(SECRET, "msg_1", 10, "{}"),
      await signWebhook(other, "msg_1", 10, "{}"),
    ]);
    expect(headers["x-mcp-subscription-id"]).toBe("sub_x");
  });
});

describe("subscription identity", () => {
  it("ignores argument key order", async () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    const base = { principal: "u1", url: "https://h.example/cb", name: "multix.job.failed" };
    const a = await subscriptionId({ ...base, arguments: { job_id: "j", x: 1 } });
    const b = await subscriptionId({ ...base, arguments: { x: 1, job_id: "j" } });
    expect(a).toBe(b);
    expect(a).toMatch(/^sub_[0-9a-f]{24}$/);
  });

  it("differs per principal", async () => {
    const base = { url: "https://h.example/cb", name: "multix.job.failed", arguments: {} };
    expect(await subscriptionId({ ...base, principal: "u1" })).not.toBe(
      await subscriptionId({ ...base, principal: "u2" }),
    );
  });
});

describe("callback address guard", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.8",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "not-an-ip",
  ])("refuses IPv4 %s", (address) => {
    expect(isNonPublicIpv4(address)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1"])("allows IPv4 %s", (address) => {
    expect(isNonPublicIpv4(address)).toBe(false);
  });

  it.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2001:0:4136:e378::1",
    "2002:a00:1::1",
    "1:2:3:4:5:6:7:8:9",
    "garbage",
  ])("refuses IPv6 %s", (address) => {
    expect(isNonPublicIpv6(address)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "allows IPv6 %s",
    (address) => {
      expect(isNonPublicIpv6(address)).toBe(false);
    },
  );

  it("accepts a host that resolves only to public addresses", async () => {
    const { fetch } = mockFetch(dohRoute("hooks.example.com", ["93.184.216.34"], ["2606:2800::1"]));
    await expect(assertPublicCallbackUrl("https://hooks.example.com/cb?x=1", fetch)).resolves.toBe(
      "https://hooks.example.com/cb?x=1",
    );
  });

  it("refuses a host with any private address (DNS pointing inside)", async () => {
    const { fetch } = mockFetch(dohRoute("rebind.example.com", ["93.184.216.34", "10.0.0.5"]));
    await expect(assertPublicCallbackUrl("https://rebind.example.com/cb", fetch)).rejects.toThrow(
      CallbackUrlError,
    );
  });

  it("refuses a host resolving to a mapped loopback over IPv6", async () => {
    const { fetch } = mockFetch(dohRoute("v6.example.com", [], ["::ffff:127.0.0.1"]));
    await expect(assertPublicCallbackUrl("https://v6.example.com/cb", fetch)).rejects.toThrow(
      CallbackUrlError,
    );
  });

  it("refuses a host that does not resolve", async () => {
    const { fetch } = mockFetch(dohRoute("other.example.com", ["1.1.1.1"]));
    await expect(assertPublicCallbackUrl("https://missing.example.com/cb", fetch)).rejects.toThrow(
      CallbackUrlError,
    );
  });

  it.each([
    "http://hooks.example.com/cb",
    "https://127.0.0.1/cb",
    "https://[::1]/cb",
    "https://localhost/cb",
    "https://user:pass@hooks.example.com/cb",
    "https://hooks.example.com:8443/cb",
    "not a url",
  ])("refuses %s without sending a DNS query", async (url) => {
    const { fetch, calls } = mockFetch();
    await expect(assertPublicCallbackUrl(url, fetch)).rejects.toThrow(CallbackUrlError);
    expect(calls).toHaveLength(0);
  });

  it("reports a DNS failure separately from an invalid URL", async () => {
    const { fetch } = mockFetch(dohRoute("hooks.example.com", ["1.1.1.1"], [], 2));
    await expect(assertPublicCallbackUrl("https://hooks.example.com/cb", fetch)).rejects.toThrow(
      CallbackDnsError,
    );
  });
});

describe("callback verification", () => {
  const URL_ = "https://hooks.example.com/cb";

  function echo(status = 200, answer?: (challenge: string) => unknown) {
    return mockFetch(
      route("POST", /^https:\/\/hooks\.example\.com\/cb$/, (call) => {
        const { challenge } = call.body as { challenge: string };
        return jsonResponse(answer ? answer(challenge) : { challenge }, status);
      }),
    );
  }

  it("passes when the callback echoes the challenge, with a valid signature", async () => {
    const { fetch, calls } = echo();
    expect(await verifyCallback(fetch, URL_, SECRET, "sub_1", () => 1_700_000_000_000)).toBeNull();
    const [call] = calls;
    expect(call?.body).toMatchObject({ type: "verification" });
    expect(call?.headers["webhook-id"]).toMatch(/^msg_verification_/);
    expect(call?.headers["webhook-timestamp"]).toBe("1700000000");
    expect(call?.headers["x-mcp-subscription-id"]).toBe("sub_1");
    expect(call?.headers["webhook-signature"]).toBe(
      await signWebhook(
        SECRET,
        call?.headers["webhook-id"] as string,
        1_700_000_000,
        JSON.stringify(call?.body),
      ),
    );
  });

  it("fails on a wrong challenge", async () => {
    const { fetch } = echo(200, () => ({ challenge: "nope" }));
    expect(await verifyCallback(fetch, URL_, SECRET, "sub_1")).toBe("challenge_failed");
  });

  it("does not follow a redirect", async () => {
    const seen: RequestInit[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } });
    };
    expect(await verifyCallback(fetch, URL_, SECRET, "sub_1")).toBe("challenge_failed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe("manual");
  });

  it.each([
    [404, "http_4xx"],
    [503, "http_5xx"],
  ] as const)("maps HTTP %i to %s", async (status, reason) => {
    const { fetch } = echo(status);
    expect(await verifyCallback(fetch, URL_, SECRET, "sub_1")).toBe(reason);
  });

  it("maps a timeout and a connection failure", async () => {
    const timeout = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    expect(await verifyCallback(timeout, URL_, SECRET, "sub_1")).toBe("timeout");
    const refused = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await verifyCallback(refused, URL_, SECRET, "sub_1")).toBe("connection_refused");
  });

  it("does not read an oversized answer", async () => {
    const fetch = async () => new Response("x".repeat(10_000), { status: 200 });
    expect(await verifyCallback(fetch, URL_, SECRET, "sub_1")).toBe("challenge_failed");
  });
});
