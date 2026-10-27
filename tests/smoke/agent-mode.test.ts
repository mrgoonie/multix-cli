/**
 * Agent mode smoke tests: the --json envelope, --dry-run (no request leaves the
 * machine), exit-code classes, and the run ledger, against dist/cli.js.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "./child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");
const SPAWN_TIMEOUT = 15_000;

describe("agent mode (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execa("node", [CLI, ...args], {
      reject: false,
      cwd: tmp,
      extendEnv: false,
      env: { ...env, ...extra },
      timeout: SPAWN_TIMEOUT - 1_000,
    });
  const envelope = (stdout: string) => {
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? "{}");
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-agent-"));
    env = {
      ...isolatedEnv(tmp),
      MULTIX_HISTORY: "1",
      MULTIX_HISTORY_FILE: path.join(tmp, "h.jsonl"),
    };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("prints one envelope with a usage class for a parse error", async () => {
    const result = await run(["gemini", "generate", "--json"]);
    expect(result.exitCode).toBe(2);
    const out = envelope(result.stdout);
    expect(out).toMatchObject({
      schema: "multix.result/v1",
      ok: false,
      command: "gemini generate",
      provider: "gemini",
    });
    expect(out.error.retryable).toBe(false);
    expect(out.next).toContain("multix gemini generate --help");
  });

  it("reports a missing key with exit 3 and the env name", async () => {
    const result = await run(["fal", "image", "a cat", "--json"], { FAL_KEY: "" });
    expect(result.exitCode).toBe(3);
    const out = envelope(result.stdout);
    expect(out.error).toMatchObject({ code: "MISSING_KEY", env: "FAL_KEY" });
    expect(out.next).toContain("multix check");
  });

  it("dry run shows the first request without sending it or the key", async () => {
    const result = await run(["fal", "image", "a cat", "--dry-run", "--json"], {
      FAL_KEY: "test-key-not-real",
      // Any real request would fail fast instead of hanging.
      HTTPS_PROXY: "http://127.0.0.1:9",
    });
    expect(result.exitCode).toBe(0);
    const out = envelope(result.stdout);
    expect(out).toMatchObject({ ok: true, dry_run: true, outputs: [] });
    expect(out.request.method).toBe("POST");
    expect(out.request.url).toMatch(/^https:\/\/[^?]+$/);
    expect(result.stdout).not.toContain("test-key-not-real");
    expect(out.next[0]).toBe("multix fal image 'a cat' --json");
  });

  it("dry run of openrouter transcribe shows the multipart upload or the URL body", async () => {
    fs.writeFileSync(path.join(tmp, "talk.mp3"), new Uint8Array(2000));
    const keyEnv = { OPENROUTER_API_KEY: "sk-or-not-real", HTTPS_PROXY: "http://127.0.0.1:9" };
    const file = await run(
      ["openrouter", "transcribe", "--input", "talk.mp3", "--dry-run", "--json"],
      keyEnv,
    );
    expect(file.exitCode).toBe(0);
    const upload = envelope(file.stdout);
    expect(upload).toMatchObject({ ok: true, dry_run: true, outputs: [] });
    expect(upload.request).toMatchObject({
      method: "POST",
      url: "https://openrouter.ai/api/v1/audio/transcriptions",
      body: { file: "<file 2000 bytes>", model: "openai/whisper-large-v3-turbo" },
    });
    const url = await run(
      [
        "openrouter",
        "transcribe",
        "--input",
        "https://cdn.example.com/talk.m4a",
        "--dry-run",
        "--json",
      ],
      keyEnv,
    );
    expect(url.exitCode).toBe(0);
    expect(envelope(url.stdout).request.body.input_audio).toEqual({
      url: "https://cdn.example.com/talk.m4a",
      format: "m4a",
    });
    expect(file.stdout + url.stdout).not.toContain("sk-or-not-real");
  });

  it("dry run never prints a URL query value from the request body", async () => {
    const image = "https://cdn.example.com/x/a.png?sig=SECRETSIG";
    const result = await run(
      ["fal", "video", "a cat", "--image-url", image, "--dry-run", "--json"],
      {
        FAL_KEY: "test-key-not-real",
        HTTPS_PROXY: "http://127.0.0.1:9",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("SECRETSIG");
    expect(envelope(result.stdout).request.body.image_url).toBe(
      "https://cdn.example.com/x/a.png?[redacted]",
    );
  });

  it("redacts a signed URL a provider echoes in its error from the envelope and ledger", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          detail: "Failed to download https://cdn.example.com/a.png?X-Amz-Signature=SECRETSIG",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await run(["fal", "image", "a cat", "--json"], {
        FAL_KEY: "test-key-not-real",
        FAL_BASE_URL: `http://127.0.0.1:${port}`,
      });
      expect(result.exitCode).toBe(5);
      expect(result.stdout + result.stderr).not.toContain("SECRETSIG");
      const out = envelope(result.stdout);
      expect(out.error).toMatchObject({ code: "PROVIDER_REJECTED", http_status: 400 });
      expect(out.error.message).toContain("https://cdn.example.com/a.png?[redacted]");
      const ledger = fs.readFileSync(path.join(tmp, "h.jsonl"), "utf8");
      expect(ledger).toContain("[redacted]");
      expect(ledger).not.toContain("SECRETSIG");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe("a signal while atlas uploads, submits or waits", () => {
    /**
     * Fake Atlas API: submit returns a processing prediction that never finishes.
     * `hold` leaves that request unanswered (a slow upload or submit); `seen.reached`
     * resolves once the held request, or else the first poll, arrives.
     */
    async function withPendingAtlas(
      fn: (
        baseUrl: string,
        seen: { posts: number; uploads: number; reached: Promise<void> },
      ) => Promise<void>,
      hold?: "upload" | "submit",
    ) {
      let markReached: () => void = () => {};
      const seen = {
        posts: 0,
        uploads: 0,
        reached: new Promise<void>((r) => {
          markReached = r;
        }),
      };
      const server = http.createServer((req, res) => {
        const upload = req.url?.endsWith("/model/uploadMedia") ?? false;
        if (upload) seen.uploads++;
        else if (req.method === "POST") seen.posts++;
        const held =
          (hold === "upload" && upload) || (hold === "submit" && req.method === "POST" && !upload);
        if (held || (!hold && req.method === "GET")) markReached();
        if (held) return; // never answered: the client stays mid-request
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: 200,
            data: upload
              ? { download_url: "https://cdn.atlas.test/ref.png" }
              : { id: "pred_sig01", status: "processing", outputs: null },
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        await fn(`http://127.0.0.1:${port}/api/v1`, seen);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }

    const start = (baseUrl: string, args: string[]) =>
      execa("node", [CLI, "atlas", ...args], {
        reject: false,
        cwd: tmp,
        extendEnv: false,
        env: { ...env, ATLASCLOUD_API_KEY: "test-key-not-real", ATLASCLOUD_BASE_URL: baseUrl },
        timeout: SPAWN_TIMEOUT - 1_000,
      });
    const generate = ["image", "a cat", "--no-validate", "--output", "my clips"];
    const resume = 'multix atlas status pred_sig01 --wait --download --output "my clips"';

    it.each([
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const)("%s exits %i with the id and resume command, not a rerun", async (signal, code) => {
      await withPendingAtlas(async (baseUrl, seen) => {
        const child = start(baseUrl, [...generate, "--json"]);
        await seen.reached;
        child.kill(signal);
        const result = await child;
        expect(result.exitCode).toBe(code);
        const out = envelope(result.stdout);
        expect(out).toMatchObject({ ok: false, command: "atlas image", exit_code: code });
        expect(out.provider_ids).toContain("pred_sig01");
        expect(out.next[0]).toBe(resume);
        expect(out.error).toMatchObject({ code: "CANCELLED", retryable: false });
        expect(out.error.hint).toContain("Do not rerun; resume it");
        expect(out.error.hint).not.toMatch(/nothing was left behind/i);
        expect(seen.posts).toBe(1);
      });
    });

    it("prints the resume command in text mode", async () => {
      await withPendingAtlas(async (baseUrl, seen) => {
        const child = start(baseUrl, generate);
        await seen.reached;
        child.kill("SIGINT");
        const result = await child;
        expect(result.exitCode).toBe(130);
        expect(result.stderr).toContain(`next: ${resume}`);
        expect(seen.posts).toBe(1);
      });
    });

    it.each([
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const)(
      "%s during status --wait exits %i with the resume command first",
      async (signal, code) => {
        await withPendingAtlas(async (baseUrl, seen) => {
          const child = start(baseUrl, [
            "status",
            "pred_sig01",
            "--wait",
            "--output",
            "my clips",
            "--json",
          ]);
          await seen.reached;
          child.kill(signal);
          const result = await child;
          expect(result.exitCode).toBe(code);
          const out = envelope(result.stdout);
          expect(out).toMatchObject({ ok: false, command: "atlas status", exit_code: code });
          expect(out.provider_ids).toContain("pred_sig01");
          expect(out.next[0]).toBe(resume);
          expect(out.error).toMatchObject({ code: "CANCELLED", retryable: false });
          expect(out.error.hint).toContain("Do not rerun; resume it");
          expect(seen.posts).toBe(0);
        });
      },
    );

    it("a signal during the submit says a paid prediction may exist, not a clean cancel", async () => {
      await withPendingAtlas(async (baseUrl, seen) => {
        const child = start(baseUrl, [...generate, "--json"]);
        await seen.reached;
        child.kill("SIGINT");
        const result = await child;
        expect(result.exitCode).toBe(130);
        const out = envelope(result.stdout);
        expect(out).toMatchObject({ ok: false, command: "atlas image", exit_code: 130 });
        expect(out.error).toMatchObject({ code: "CANCELLED", retryable: false });
        expect(out.error.hint).toContain("Check the Atlas Cloud dashboard before resubmitting");
        expect(out.error.hint).not.toMatch(/nothing was left behind/i);
        expect(out.next).not.toContain(resume);
        expect(seen.posts).toBe(1);
      }, "submit");
    });

    it("prints the submit warning in text mode", async () => {
      await withPendingAtlas(async (baseUrl, seen) => {
        const child = start(baseUrl, generate);
        await seen.reached;
        child.kill("SIGTERM");
        const result = await child;
        expect(result.exitCode).toBe(143);
        expect(result.stderr).toContain("Cancelled while submitting");
        expect(result.stderr).toContain("Atlas Cloud dashboard");
      }, "submit");
    });

    it("a signal during a --ref upload is a clean cancel: nothing was submitted", async () => {
      fs.writeFileSync(path.join(tmp, "ref.png"), Buffer.from("89504e470d0a1a0a", "hex"));
      await withPendingAtlas(async (baseUrl, seen) => {
        const child = start(baseUrl, [
          "image-to-image",
          "--prompt",
          "make it blue",
          "--ref",
          "ref.png",
          "--no-validate",
          "--json",
        ]);
        await seen.reached;
        child.kill("SIGINT");
        const result = await child;
        expect(result.exitCode).toBe(130);
        const out = envelope(result.stdout);
        expect(out).toMatchObject({ ok: false, command: "atlas image-to-image", exit_code: 130 });
        expect(out.error).toMatchObject({ code: "CANCELLED" });
        expect(out.error.hint).toMatch(/nothing was left behind/i);
        expect(seen.uploads).toBe(1);
        expect(seen.posts).toBe(0);
      }, "upload");
    });
  });

  it("records runs in the ledger and shows them with history", async () => {
    await run(["fal", "image", "--help"]); // help is not a run
    await run(["fal", "image", "a cat"], { FAL_KEY: "" });
    const list = await run(["history", "--json"]);
    expect(list.exitCode).toBe(0);
    const rows = envelope(list.stdout).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command: "fal image",
      provider: "fal",
      ok: false,
      exit_code: 1, // plain runs keep exit 1; the class is in error.code
      error: { code: "MISSING_KEY" },
    });
    const show = await run(["history", "show", "last"]);
    expect(JSON.parse(show.stdout).id).toBe(rows[0].id);
    // rerun forwards --dry-run to the recorded command instead of spending again.
    const again = await run(["rerun", "last", "--dry-run", "--json"], {
      FAL_KEY: "test-key-not-real",
      HTTPS_PROXY: "http://127.0.0.1:9",
    });
    expect(again.exitCode).toBe(0);
    expect(envelope(again.stdout)).toMatchObject({ dry_run: true, command: "fal image" });
  });

  it("keeps exit 1 without --json but prints the code, hint and next steps", async () => {
    const result = await run(["fal", "image", "a cat"], { FAL_KEY: "" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("code: MISSING_KEY (exit 3 with --json)");
    expect(result.stderr).toContain("next: multix check");
  });

  it("lists models by task as JSON and in the guide", async () => {
    const models = await run(["models", "--task", "speech", "--json"]);
    expect(models.exitCode).toBe(0);
    const rows = envelope(models.stdout).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { task: string }) => r.task === "speech")).toBe(true);
    const guide = await run(["guide"]);
    expect(guide.stdout).toContain("multix.result/v1");
  });
});
