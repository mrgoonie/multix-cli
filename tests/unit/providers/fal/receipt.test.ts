/**
 * fal detach receipts: stable input hash, owner-only atomic write, and resume
 * commands that only read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildReceipt,
  defaultReceiptPath,
  inputHash,
  writeReceipt,
} from "../../../../src/providers/fal/receipt.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fal-receipt-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("inputHash", () => {
  it("ignores key order and changes with the input", () => {
    const a = inputHash({ prompt: "x", video_url: "https://a", opts: { b: 1, a: 2 } });
    const b = inputHash({ opts: { a: 2, b: 1 }, video_url: "https://a", prompt: "x" });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(inputHash({ prompt: "y" })).not.toBe(inputHash({ prompt: "x" }));
  });
});

describe("buildReceipt", () => {
  it("holds ids, the hash and resume commands, never the input", () => {
    const receipt = buildReceipt({
      model: "fal-ai/mmaudio-v2",
      requestId: "req-1",
      queuePosition: 2,
      input: { video_url: "https://v3b.fal.media/files/private.mp4" },
      submittedAt: new Date("2026-10-25T00:00:00Z"),
    });
    expect(receipt).toMatchObject({
      schema: "multix.fal-receipt/v1",
      provider: "fal",
      model: "fal-ai/mmaudio-v2",
      request_id: "req-1",
      status: "IN_QUEUE",
      queue_position: 2,
      submitted_at: "2026-10-25T00:00:00.000Z",
      next: {
        status: "multix fal status fal-ai/mmaudio-v2 req-1",
        result: "multix fal result fal-ai/mmaudio-v2 req-1 --download",
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("private.mp4");
  });
});

describe("writeReceipt", () => {
  it("writes owner-only JSON atomically, leaving no temp file", () => {
    const receipt = buildReceipt({ model: "fal-ai/x", requestId: "r1", input: {} });
    const file = path.join(tmp, "nested", "r1.json");
    expect(writeReceipt(receipt, file)).toBe(file);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ request_id: "r1", receipt_path: file });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["r1.json"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps request ids inside the receipts directory", () => {
    const p = defaultReceiptPath("../../etc/passwd");
    expect(path.dirname(p)).toBe(path.join(os.homedir(), ".multix", "fal", "requests"));
  });
});
