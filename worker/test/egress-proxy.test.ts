/**
 * The job egress proxy (container/egress-proxy.mjs): the CLI of a self-hosted
 * job reaches only public addresses, checked when the proxy connects, even
 * for a host name that resolves to a metadata, private or loopback address or
 * that rebinds between lookups. Name resolution is faked; the only real
 * sockets are on loopback.
 */

import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: untyped .mjs modules
type Any = any;
const testFileUrl = (import.meta as unknown as { url: string }).url;
const local = (rel: string) => decodeURIComponent(new URL(rel, testFileUrl).pathname);
const load = (rel: string): Promise<Any> => import(/* @vite-ignore */ local(rel));
const proxyMod = () => load("../container/egress-proxy.mjs");
const networkMod = () => load("../container/job-network.mjs");

const FAKE_BIN = local("./fixtures/fake-multix.mjs");

type Answer = { address: string; family: number };
const v4 = (address: string): Answer => ({ address, family: 4 });
const v6 = (address: string): Answer => ({ address, family: 6 });

/** A dns.lookup stand-in: each host name maps to a list of answers, one per call (the last repeats). */
function fakeResolver(table: Record<string, Answer[][]>) {
  const calls: string[] = [];
  const resolve = (host: string, _opts: unknown, cb: (e: Error | null, a?: Answer[]) => void) => {
    calls.push(host);
    const answers = table[host];
    if (!answers)
      return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
    const seen = calls.filter((h) => h === host).length;
    cb(null, answers[Math.min(seen, answers.length) - 1]);
  };
  return { resolve, calls };
}

/** A lookup that sends every name to loopback, for testing the forwarding itself. */
function loopbackLookup(_host: string, opts: Any, cb: Any) {
  const options = typeof opts === "function" ? {} : opts;
  const callback = typeof opts === "function" ? opts : cb;
  if (options?.all) return callback(null, [v4("127.0.0.1")]);
  return callback(null, "127.0.0.1", 4);
}

/** A loopback HTTP server standing in for an internal service; counts what reaches it. */
async function internalService() {
  const hits: { url: string; headers: Record<string, unknown> }[] = [];
  const server: Server = createServer((req, res) => {
    hits.push({ url: String(req.url), headers: req.headers });
    res.end("internal-secret");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { server, port, hits };
}

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function startProxy(options: Any = {}) {
  const { startEgressProxy } = await proxyMod();
  const proxy = await startEgressProxy(options);
  closers.push(() => proxy.close());
  return proxy;
}

async function publicOnly(table: Record<string, Answer[][]>) {
  const { createPublicLookup } = await networkMod();
  const resolver = fakeResolver(table);
  return { lookup: createPublicLookup(resolver.resolve), calls: resolver.calls };
}

function basicAuth(proxyUrl: string) {
  const u = new URL(proxyUrl);
  return `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`;
}

/** Send one raw request to the proxy; resolves with the status line and the raw reply so far. */
async function raw(
  proxy: Any,
  text: string,
): Promise<{ status: number; reply: string; socket: Any }> {
  const socket = connect(proxy.port, "127.0.0.1");
  closers.push(() => socket.destroy());
  await once(socket, "connect");
  socket.write(text);
  // A data listener, not `for await`: breaking out of the iterator would destroy the tunnel.
  const reply = await new Promise<string>((resolve) => {
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\r\n\r\n")) done();
    };
    const done = () => {
      socket.off("data", onData);
      socket.off("close", done);
      socket.pause();
      resolve(text);
    };
    socket.on("data", onData);
    socket.once("close", done);
  });
  return { status: Number(reply.split(" ")[1]), reply, socket };
}

const connectReq = (authority: string, auth?: string) =>
  `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`;

describe("egress proxy: blocked destinations", () => {
  it("refuses CONNECT to host names that resolve to metadata, private, loopback or cluster addresses", async () => {
    const internal = await internalService();
    closers.push(() => internal.server.close());
    const { lookup } = await publicOnly({
      "metadata.attacker.test": [[v4("169.254.169.254")]],
      "ten.attacker.test": [[v4("10.0.0.7")]],
      "loop6.attacker.test": [[v6("::1")]],
      "mapped.attacker.test": [[v6("::ffff:127.0.0.1")]],
      "cluster.attacker.test": [[v4("172.20.0.1")]],
      "cgnat.attacker.test": [[v4("100.64.0.10")]],
      "mixed.attacker.test": [[v4("93.184.216.34"), v4("127.0.0.1")]],
    });
    const proxy = await startProxy({ lookup });
    const auth = basicAuth(proxy.url);
    for (const host of [
      "metadata.attacker.test",
      "ten.attacker.test",
      "loop6.attacker.test",
      "mapped.attacker.test",
      "cluster.attacker.test",
      "cgnat.attacker.test",
      "mixed.attacker.test",
    ]) {
      const { status, reply } = await raw(proxy, connectReq(`${host}:${internal.port}`, auth));
      expect(status, host).toBe(403);
      expect(reply).toContain("not a public address");
    }
    expect(internal.hits).toEqual([]);
  });

  it("refuses IP literals that are not public, without a DNS lookup", async () => {
    const { lookup, calls } = await publicOnly({});
    const proxy = await startProxy({ lookup });
    const auth = basicAuth(proxy.url);
    for (const authority of [
      "127.0.0.1:80",
      "169.254.169.254:80",
      "10.1.2.3:443",
      "[::1]:443",
      "[fd00::1]:443",
      "[fe80::1]:443",
      "[::ffff:169.254.169.254]:80",
      "0.0.0.0:80",
    ]) {
      expect((await raw(proxy, connectReq(authority, auth))).status, authority).toBe(403);
    }
    const plain = await raw(
      proxy,
      `GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    expect(plain.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("checks every connection again, so a rebinding host gets its private answer refused", async () => {
    const internal = await internalService();
    closers.push(() => internal.server.close());
    // First lookup: a public address; second lookup of the same name: loopback.
    const checked = await publicOnly({
      "rebind.attacker.test": [[v4("93.184.216.34")], [v4("127.0.0.1")]],
    });
    const { calls } = checked;
    // Keep the test off the network: an address that passed the check is dialled on 127.0.0.2,
    // where nothing listens (the internal service is bound to 127.0.0.1 only).
    const lookup = (host: string, opts: Any, cb: Any) =>
      checked.lookup(host, opts, (error: Any, address: Any, family: Any) => {
        if (error) return cb(error);
        if (Array.isArray(address))
          return cb(
            null,
            address.map(() => v4("127.0.0.2")),
          );
        return cb(null, "127.0.0.2", family);
      });
    const proxy = await startProxy({ lookup });
    const auth = basicAuth(proxy.url);
    const first = await raw(proxy, connectReq(`rebind.attacker.test:${internal.port}`, auth));
    expect(first.status).toBe(502);
    const second = await raw(proxy, connectReq(`rebind.attacker.test:${internal.port}`, auth));
    expect(second.status).toBe(403);
    expect(calls).toEqual(["rebind.attacker.test", "rebind.attacker.test"]);
    expect(internal.hits).toEqual([]);
  });

  it("refuses requests without the proxy credential and absolute-form https or bad targets", async () => {
    const proxy = await startProxy({ lookup: loopbackLookup });
    const challenge = await raw(proxy, connectReq("example.com:443"));
    expect(challenge.status).toBe(407);
    // ffmpeg sends its credential only after a 407 that carries the challenge.
    expect(challenge.reply).toMatch(/Proxy-Authenticate: Basic realm="multix-job"/i);
    expect(
      (await raw(proxy, connectReq("example.com:443", "Basic bXVsdGl4LWpvYjp3cm9uZw=="))).status,
    ).toBe(407);
    const auth = basicAuth(proxy.url);
    expect((await raw(proxy, connectReq("example.com", auth))).status).toBe(400);
    expect((await raw(proxy, connectReq("example.com:0", auth))).status).toBe(400);
    expect((await raw(proxy, connectReq("[not-an-ip]:443", auth))).status).toBe(400);
    const https = await raw(
      proxy,
      `GET https://example.com/ HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    expect(https.status).toBe(400);
  });

  it("listens on loopback only", async () => {
    const proxy = await startProxy();
    expect(new URL(proxy.url).hostname).toBe("127.0.0.1");
  });
});

describe("egress proxy: allowed destinations", () => {
  it("tunnels CONNECT and forwards absolute-form http to addresses the lookup accepts", async () => {
    const target = await internalService();
    closers.push(() => target.server.close());
    const proxy = await startProxy({ lookup: loopbackLookup });
    const auth = basicAuth(proxy.url);

    const tunnel = await raw(proxy, connectReq(`public.example.test:${target.port}`, auth));
    expect(tunnel.status).toBe(200);
    tunnel.socket.write("GET /through-tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    let body = "";
    for await (const chunk of tunnel.socket) body += chunk.toString();
    expect(body).toContain("internal-secret");

    const plain = await raw(
      proxy,
      `GET http://public.example.test:${target.port}/plain?q=1 HTTP/1.1\r\nHost: public.example.test\r\nProxy-Authorization: ${auth}\r\nProxy-Connection: keep-alive\r\nX-Kept: yes\r\n\r\n`,
    );
    expect(plain.status).toBe(200);
    expect(target.hits.map((h) => h.url)).toEqual(["/through-tunnel", "/plain?q=1"]);
    const forwarded = target.hits[1]?.headers ?? {};
    expect(forwarded["proxy-authorization"]).toBeUndefined();
    expect(forwarded["proxy-connection"]).toBeUndefined();
    expect(forwarded["x-kept"]).toBe("yes");
  });

  it("answers 502 when a public destination cannot be reached", async () => {
    const { lookup } = await publicOnly({ "nxdomain.example.test": [] });
    const proxy = await startProxy({ lookup });
    expect(
      (await raw(proxy, connectReq("gone.example.test:443", basicAuth(proxy.url)))).status,
    ).toBe(502);
  });

  it("close() stops the listener and open tunnels", async () => {
    const target = await internalService();
    closers.push(() => target.server.close());
    const proxy = await startProxy({ lookup: loopbackLookup });
    const tunnel = await raw(proxy, connectReq(`x.test:${target.port}`, basicAuth(proxy.url)));
    expect(tunnel.status).toBe(200);
    await proxy.close();
    await once(tunnel.socket, "close");
    const refused = connect(proxy.port, "127.0.0.1");
    const [error] = await once(refused, "error");
    expect((error as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
  });
});

describe("egress proxy: the job CLI goes through it", () => {
  it("proxyEnvFor sets every proxy variable, clears the bypass list and enables Node's env proxy", async () => {
    const { proxyEnvFor } = await proxyMod();
    const env = proxyEnvFor("http://u:p@127.0.0.1:1");
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      expect(env[name]).toBe("http://u:p@127.0.0.1:1");
    }
    expect(env.NO_PROXY).toBe("");
    expect(env.no_proxy).toBe("");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
  });

  it("a Node fetch in a child process cannot reach a name that resolves to an internal address", async () => {
    const internal = await internalService();
    closers.push(() => internal.server.close());
    const { lookup } = await publicOnly({
      "metadata.attacker.test": [[v4("169.254.169.254")]],
      "rebind.attacker.test": [[v4("127.0.0.1")]],
      "ipv6.attacker.test": [[v6("::1")]],
    });
    const proxy = await startProxy({ lookup });
    const script = `fetch(process.argv[1]).then(async (r) => console.log(r.status, await r.text()), (e) => console.log("error", e.cause?.message ?? e.message))`;
    for (const url of [
      `http://metadata.attacker.test:${internal.port}/latest/meta-data/`,
      `http://rebind.attacker.test:${internal.port}/`,
      `https://ipv6.attacker.test:${internal.port}/`,
      `http://127.0.0.1:${internal.port}/`,
      `http://[::1]:${internal.port}/`,
    ]) {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve) =>
        execFile(
          process.execPath,
          ["-e", script, url],
          { env: { PATH: process.env.PATH ?? "", ...proxy.env }, timeout: 15_000 },
          (_e, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr) }),
        ),
      );
      expect(stdout, url).toMatch(/^error /);
      expect(stdout).not.toContain("internal-secret");
      expect(stderr).not.toContain("EnvHttpProxyAgent is experimental");
    }
    expect(internal.hits).toEqual([]);
  });

  it("runJob applies egressEnv, the CLI's fetch of loopback is refused and the credential is redacted", async () => {
    const internal = await internalService();
    closers.push(() => internal.server.close());
    const proxy = await startProxy();
    const { runJob } = await load("../container/job-runner.mjs");
    const result = await runJob(
      {
        jobId: "11111111-2222-4333-8444-555555555555",
        // Reachable directly: only the proxy stands between the CLI and this service.
        argv: ["image", "describe", "--print-proxy", `--fetch=http://127.0.0.1:${internal.port}/`],
        env: { GEMINI_API_KEY: "AIza-gemini-secret-value-1234" },
        inputs: [],
        timeoutMs: 20_000,
      },
      {
        bin: FAKE_BIN,
        egressEnv: proxy.env,
        fetch: async () => {
          throw new Error("no upload expected");
        },
      },
    );
    expect(result.status).toBe("succeeded");
    const report = JSON.parse(result.stdout.split("\n")[0]);
    expect(report.envNames).toEqual(expect.arrayContaining(["HTTPS_PROXY", "NODE_USE_ENV_PROXY"]));
    const outcome = JSON.parse(/fetch-outcome (.*)/.exec(result.stderrTail)?.[1] ?? "null");
    expect(outcome?.error).toBeTruthy();
    expect(result.stderrTail).not.toContain("internal-secret");
    expect(internal.hits).toEqual([]);
    expect(result.stderrTail).toContain("proxy http://multix-job:[redacted]@127.0.0.1:");
    expect(result.stderrTail).not.toContain(proxy.token);
  });

  it("ends the client's response when a forwarded http upstream aborts mid-body", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    closers.push(() => upstream.close());
    const proxy = await startProxy({ lookup: loopbackLookup });
    const port = (upstream.address() as { port: number }).port;
    const reply = await raw(
      proxy,
      `GET http://public.example.test:${port}/ HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${basicAuth(proxy.url)}\r\n\r\n`,
    );
    expect(reply.status).toBe(200);
    reply.socket.resume();
    const closed = await Promise.race([
      once(reply.socket, "close").then(() => true),
      new Promise((r) => setTimeout(() => r(false), 3_000)),
    ]);
    expect(closed).toBe(true);
  });

  it("verify() passes when node honours the proxy and fails closed when it does not", async () => {
    const proxy = await startProxy();
    await expect(proxy.verify()).resolves.toBeUndefined();
    // A `node` that ignores the proxy (here: does nothing) must make verify() throw.
    const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "multix-fake-node-"));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "node"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "node"), 0o755);
    await expect(proxy.verify(`${dir}:/usr/bin:/bin`)).rejects.toThrow(/HTTPS_PROXY/);
  });
});
