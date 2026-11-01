import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPublicAddress, publicOnlyAgent, publicOnlyLookup } from "../public-fetch-guard.js";

describe("public-only fetch", () => {
  let server: ReturnType<typeof createServer>;
  let port = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => res.end("internal"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("classifies addresses", () => {
    for (const a of [
      "127.0.0.1",
      "10.0.0.5",
      "169.254.169.254",
      "192.168.1.1",
      "::1",
      "fd00::1",
      "0.0.0.0",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });

  it("refuses to connect to loopback by IP literal and by name", async () => {
    const dispatcher = publicOnlyAgent();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      await expect(fetch(`http://${host}/`, { dispatcher } as RequestInit), host).rejects.toThrow();
    }
    await dispatcher.close();
  });

  it("fails a lookup that resolves to a non-public address", async () => {
    const error = await new Promise<Error | null>((resolve) =>
      publicOnlyLookup("localhost", { all: true }, (err) => resolve(err)),
    );
    expect(error?.name).toBe("NonPublicAddressError");
  });
});
