import { describe, expect, it } from "vitest";
import { EVENT_CATALOG, EVENT_NAMES } from "../src/events/event-catalog.js";
import type { MultixEvent } from "../src/events/event-catalog.js";
import {
  OUTBOX_PREFIX,
  RELAY_ATTEMPTS,
  outboxKey,
  relayDelaySeconds,
  relayOutbox,
} from "../src/events/event-outbox.js";
import { MAX_ASSET_EVENTS, jobEvents } from "../src/events/job-events.js";
import {
  JOB_RETENTION_SECONDS,
  type JobView,
  SERVER_AT_CAPACITY_ERROR,
} from "../src/jobs/job-protocol.js";

const SOURCE = { jobId: "00000000-0000-4000-8000-000000000001", command: "gemini generate" };
const T = Date.UTC(2026, 9, 15, 10, 0, 0);

function view(status: JobView["status"], outputs: { url: string | null }[] = []): JobView {
  return {
    status,
    createdAt: T - 30_000,
    finishedAt: T,
    error: "Prompt 'a secret plan' failed at https://signed.example/x?sig=1",
    result:
      status === "running" || status === "starting"
        ? undefined
        : {
            status,
            exitCode: status === "succeeded" ? 0 : 1,
            stdout: "prompt: a secret plan",
            stderrTail: "GEMINI_API_KEY=abc",
            outputs: outputs.map((o, i) => ({ name: `out-${i}.png`, bytes: 100 + i, url: o.url })),
            error: "upload to https://bucket.example/x?X-Amz-Signature=zzz failed",
          },
  };
}

describe("jobEvents", () => {
  it("produces exactly one job event per terminal status, with a stable id", () => {
    const expected = {
      succeeded: "multix.job.completed",
      failed: "multix.job.failed",
      canceled: "multix.job.canceled",
      timed_out: "multix.job.timed_out",
    } as const;
    for (const [status, name] of Object.entries(expected)) {
      const events = jobEvents(SOURCE, view(status as JobView["status"]));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: `evt_${SOURCE.jobId}_${status}`,
        name,
        schema_version: 1,
        occurred_at: new Date(T).toISOString(),
        resource: { type: "job", id: SOURCE.jobId },
        data: { job_id: SOURCE.jobId, status, command: "gemini generate", provider: "gemini" },
      });
      expect(jobEvents(SOURCE, view(status as JobView["status"]))).toEqual(events);
    }
  });

  it("produces nothing for a job refused for capacity, whose id the caller never got", () => {
    const refused = { ...view("failed"), error: SERVER_AT_CAPACITY_ERROR };
    expect(jobEvents(SOURCE, refused)).toEqual([]);
  });

  it("produces nothing while the job runs", () => {
    expect(jobEvents(SOURCE, view("running"))).toEqual([]);
    expect(jobEvents(SOURCE, view("starting"))).toEqual([]);
  });

  it("adds asset events only for stored outputs of a successful job", () => {
    const outputs = [{ url: "https://r2.example/a.png?X-Amz-Signature=1" }, { url: null }];
    const ok = jobEvents(SOURCE, view("succeeded", outputs));
    expect(ok.map((e) => e.name)).toEqual(["multix.job.completed", "multix.asset.ready"]);
    expect(ok[1]).toMatchObject({
      id: `evt_${SOURCE.jobId}_asset_0`,
      data: { index: 0, name: "out-0.png", bytes: 100 },
    });
    expect(ok[0]?.data).toMatchObject({
      outputs: [
        { name: "out-0.png", bytes: 100, stored: true },
        { name: "out-1.png", bytes: 101, stored: false },
      ],
    });
    expect(jobEvents(SOURCE, view("failed", outputs)).map((e) => e.name)).toEqual([
      "multix.job.failed",
    ]);
    const many = Array.from({ length: MAX_ASSET_EVENTS + 5 }, () => ({
      url: "https://r2.example/x",
    }));
    expect(jobEvents(SOURCE, view("succeeded", many))).toHaveLength(1 + MAX_ASSET_EVENTS);
  });

  it("leaves prompts, CLI output, error text, keys and URLs out of every payload", () => {
    const outputs = [{ url: "https://r2.example/a.png?X-Amz-Signature=1" }];
    for (const status of ["succeeded", "failed", "canceled", "timed_out"] as const) {
      const text = JSON.stringify(jobEvents(SOURCE, view(status, outputs)));
      for (const leak of [
        "secret plan",
        "GEMINI_API_KEY",
        "https://",
        "Signature",
        "stdout",
        "userId",
      ]) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it("catalogs every published event name with a data schema", () => {
    expect(EVENT_CATALOG.map((e) => e.name)).toEqual([...EVENT_NAMES]);
    for (const entry of EVENT_CATALOG) expect(entry.data_schema).toHaveProperty("required");
  });
});

function outbox(events: MultixEvent[], publish?: (events: MultixEvent[]) => Promise<unknown>) {
  const data = new Map(events.map((e) => [outboxKey(e.id), e]));
  const retries: { attempt: number; seconds: number }[] = [];
  return {
    data,
    retries,
    port: {
      list: async () => new Map(data),
      delete: async (keys: string[]) => {
        for (const key of keys) data.delete(key);
      },
      publish,
      scheduleRelay: async (attempt: number, seconds: number) => {
        retries.push({ attempt, seconds });
      },
    },
  };
}

describe("relayOutbox", () => {
  const events = jobEvents(SOURCE, view("succeeded", [{ url: "https://r2.example/a" }]));

  it("hands the stored events over and only then deletes them", async () => {
    const published: MultixEvent[][] = [];
    const box = outbox(events, async (list) => {
      published.push(list);
    });
    await relayOutbox(box.port);
    expect(published).toEqual([events]);
    expect(box.data.size).toBe(0);
    expect([...outbox(events).data.keys()].every((k) => k.startsWith(OUTBOX_PREFIX))).toBe(true);
  });

  it("keeps the events and retries with a growing delay when the hand-over fails", async () => {
    const box = outbox(events, async () => {
      throw new Error("AccountEvents unavailable");
    });
    for (let attempt = 1; attempt <= RELAY_ATTEMPTS; attempt++)
      await relayOutbox(box.port, attempt);
    expect(box.data.size).toBe(events.length);
    expect(box.retries.map((r) => r.attempt)).toEqual(
      Array.from({ length: RELAY_ATTEMPTS - 1 }, (_, i) => i + 2),
    );
    expect(box.retries.map((r) => r.seconds)).toEqual(
      box.retries.map((r) => relayDelaySeconds(r.attempt)),
    );
    expect(relayDelaySeconds(2)).toBe(10);
    expect(relayDelaySeconds(3)).toBe(20);
    expect(relayDelaySeconds(30)).toBe(3600);
  });

  it("keeps retrying hourly for as long as the job's data is kept", () => {
    let total = 0;
    for (let attempt = 2; attempt <= RELAY_ATTEMPTS; attempt++) total += relayDelaySeconds(attempt);
    expect(total).toBeGreaterThanOrEqual(JOB_RETENTION_SECONDS);
  });

  it("schedules another attempt when reading the outbox fails", async () => {
    const box = outbox(events, async () => undefined);
    box.port.list = async () => {
      throw new Error("storage reset");
    };
    await relayOutbox(box.port, 3);
    expect(box.retries).toEqual([{ attempt: 4, seconds: relayDelaySeconds(4) }]);
  });

  it("does nothing when events are not configured or the outbox is empty", async () => {
    const box = outbox(events);
    await relayOutbox(box.port);
    expect(box.data.size).toBe(events.length);
    expect(box.retries).toEqual([]);
  });
});
