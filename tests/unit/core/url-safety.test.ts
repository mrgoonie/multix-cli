import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../../../src/core/errors.js";
import { checkUrlSafety, isLoopbackHost, isNonPublicHost } from "../../../src/core/url-safety.js";

const opts = { provider: "test", trustedHosts: ["cdn.trusted.test"] };

describe("url-safety module", () => {
  it("is runtime-neutral (no node:* imports)", () => {
    const src = fs.readFileSync(path.resolve("src/core/url-safety.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']node:/);
    expect(src).not.toMatch(/process\./);
  });
});

describe("checkUrlSafety", () => {
  it("reports trusted hosts and their subdomains", () => {
    expect(checkUrlSafety("https://cdn.trusted.test/a?sig=1", opts)).toEqual({
      host: "cdn.trusted.test",
      trusted: true,
    });
    expect(checkUrlSafety("https://eu.cdn.trusted.test/a", opts).trusted).toBe(true);
    expect(checkUrlSafety("https://cdn.trusted.test.evil.com/a", opts).trusted).toBe(false);
    expect(checkUrlSafety("https://example.com/a", { provider: "test" }).trusted).toBe(false);
  });

  it("is not fooled by userinfo or fragments", () => {
    expect(checkUrlSafety("https://cdn.trusted.test@evil.com/", opts)).toEqual({
      host: "evil.com",
      trusted: false,
    });
    expect(checkUrlSafety("https://evil.com#@cdn.trusted.test", opts).host).toBe("evil.com");
    expect(() => checkUrlSafety("https://cdn.trusted.test@127.0.0.1/", opts)).toThrow(
      /local or private address/,
    );
  });

  it("refuses non-https and malformed URLs with a ProviderError naming the host only", () => {
    expect(() => checkUrlSafety("http://example.com/x?sig=SECRET", opts)).toThrow(/only https/);
    try {
      checkUrlSafety("http://example.com/x?sig=SECRET", opts);
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).provider).toBe("test");
      expect((e as Error).message).toContain("example.com");
      expect((e as Error).message).not.toContain("SECRET");
    }
    expect(() => checkUrlSafety("not a url", opts)).toThrow(/malformed URL/);
    expect(() => checkUrlSafety("file:///etc/passwd", opts)).toThrow(/only https/);
  });

  it.each([
    "https://localhost/x",
    "https://LOCALHOST./x",
    "https://app.localhost/x",
    "https://127.0.0.1/x",
    "https://127.1/x",
    "https://0177.0.0.1/x",
    "https://0x7f.1/x",
    "https://2130706433/x",
    "https://127.0.0.1./x",
    "https://10.1.2.3/x",
    "https://172.16.0.1/x",
    "https://192.168.1.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/x",
    "https://0.0.0.0/x",
    "https://192.0.0.8/x",
    "https://192.0.2.1/x",
    "https://198.18.0.1/x",
    "https://198.19.255.1/x",
    "https://198.51.100.7/x",
    "https://203.0.113.9/x",
    "https://224.0.0.1/x",
    "https://255.255.255.255/x",
    "https://[::]/x",
    "https://[::1]/x",
    "https://[::7f00:1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://[::ffff:169.254.169.254]/x",
    "https://[fc00::1]/x",
    "https://[fd00::1]/x",
    "https://[fe80::1]/x",
    "https://[febf::1]/x",
    "https://[fec0::1]/x",
    "https://[ff02::1]/x",
    "https://[100::1]/x",
    "https://[64:ff9b::127.0.0.1]/x",
    "https://[64:ff9b::a00:1]/x",
    "https://[2002:7f00:1::1]/x",
    "https://[2002:c0a8:101::]/x",
  ])("refuses the non-public literal %s", (url) => {
    expect(() => checkUrlSafety(url, opts)).toThrow(/local or private address/);
  });

  it.each([
    "https://8.8.8.8/x",
    "https://93.184.216.34/x",
    "https://[2001:db8::1]/x",
    "https://[2606:4700::1111]/x",
    "https://[::ffff:8.8.8.8]/x",
    "https://[64:ff9b::8.8.8.8]/x",
    "https://[2002:808:808::1]/x",
    "https://198.20.0.1/x",
    "https://192.0.1.1/x",
  ])("allows the public address %s (untrusted)", (url) => {
    expect(checkUrlSafety(url, opts).trusted).toBe(false);
  });

  it("allowLocalhostHttp permits loopback dev servers only", () => {
    const dev = { ...opts, allowLocalhostHttp: true };
    expect(checkUrlSafety("http://localhost:3000/x", dev).host).toBe("localhost");
    expect(checkUrlSafety("http://127.0.0.1:8787/x", dev).host).toBe("127.0.0.1");
    expect(checkUrlSafety("http://[::1]:8787/x", dev).host).toBe("[::1]");
    expect(checkUrlSafety("https://app.localhost/x", dev).trusted).toBe(false);
    expect(() => checkUrlSafety("http://10.0.0.1/x", dev)).toThrow(/only https/);
    expect(() => checkUrlSafety("https://10.0.0.1/x", dev)).toThrow(/local or private/);
    expect(() => checkUrlSafety("http://example.com/x", dev)).toThrow(/only https/);
    expect(() => checkUrlSafety("http://localhost/x", opts)).toThrow(/only https/);
  });

  it("uses the action phrase in messages", () => {
    expect(() =>
      checkUrlSafety("http://example.com/", { provider: "atlas", action: "follow a redirect to" }),
    ).toThrow("Refusing to follow a redirect to example.com");
  });
});

describe("host classifiers", () => {
  it("isNonPublicHost accepts bracketed and bare IPv6 hostnames", () => {
    expect(isNonPublicHost("[::1]")).toBe(true);
    expect(isNonPublicHost("::1")).toBe(true);
    expect(isNonPublicHost("example.com")).toBe(false);
    expect(isNonPublicHost("not:an:ip:zz")).toBe(false);
  });

  it("isLoopbackHost covers localhost, 127/8, ::1, and mapped loopback", () => {
    for (const h of [
      "localhost",
      "a.localhost",
      "127.0.0.1",
      "127.9.9.9",
      "[::1]",
      "::ffff:7f00:1",
    ]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ["10.0.0.1", "[::2]", "example.com", "[fe80::1]"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});
