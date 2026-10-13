/**
 * Life cycle of one job inside its Durable Object, kept free of the
 * Containers runtime so it can be unit-tested: the DO class
 * (multix-job-container.ts) supplies the port.
 *
 * start -> POST /jobs to the job server -> poll GET /jobs/current (self
 * scheduled, and on every status read) -> persist the final result -> release
 * the account's job slot -> destroy the container. Only the job view is
 * stored; the spec with its secrets is never persisted.
 *
 * Only start() boots a container. Status reads and cancel talk to a container
 * that is already running; when it is gone, the job is finished from the
 * stored state instead of starting a new container to ask.
 */

import {
  JOB_GIVE_UP_MS,
  type JobResult,
  type JobSpec,
  type JobTerminalStatus,
  type JobView,
  SERVER_AT_CAPACITY_ERROR,
  isTerminal,
} from "./job-protocol.js";

export interface JobContainerPort {
  load(): Promise<JobView | undefined>;
  save(view: JobView): Promise<void>;
  /** Boot the container and wait for the job server; throws ContainerCapacityError when none is free. */
  startContainer(): Promise<void>;
  /** Whether the container is running now (never starts it). */
  isContainerRunning(): boolean;
  /** Request to the job server of the running container; never starts one. */
  fetchContainer(path: string, init?: RequestInit): Promise<Response>;
  destroyContainer(): Promise<void>;
  schedulePoll(seconds: number): Promise<void>;
  /** Give back the account's job slot (idempotent). */
  releaseSlot(): Promise<void>;
  now(): number;
}

/** No container instance is free (`max_instances`) or the platform rate-limited the start. */
export class ContainerCapacityError extends Error {
  constructor() {
    super(SERVER_AT_CAPACITY_ERROR);
    this.name = "ContainerCapacityError";
  }
}

export const POLL_SECONDS = 5;
/** A job still `starting` after this long lost its start call (the Durable Object was reset). */
const START_GIVE_UP_MS = 5 * 60_000;

interface CurrentJob {
  state: "idle" | "running" | "done";
  result?: JobResult;
}

function isCurrentJob(value: unknown): value is CurrentJob {
  if (!value || typeof value !== "object") return false;
  const state = (value as { state?: unknown }).state;
  return state === "idle" || state === "running" || state === "done";
}

export class JobController {
  constructor(private readonly port: JobContainerPort) {}

  async start(spec: JobSpec): Promise<JobView> {
    const existing = await this.port.load();
    if (existing) return existing;
    const view: JobView = { status: "starting", createdAt: this.port.now() };
    await this.port.save(view);
    try {
      await this.port.startContainer();
      const response = await this.port.fetchContainer("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spec),
      });
      await response.body?.cancel();
      if (response.status !== 202) {
        return this.finish(
          view,
          "failed",
          `The job server refused the job (HTTP ${response.status})`,
        );
      }
    } catch (error) {
      const message =
        error instanceof ContainerCapacityError
          ? SERVER_AT_CAPACITY_ERROR
          : "The job container could not be started";
      return this.finish(view, "failed", message);
    }
    // The container may have stopped (and onStop recorded it) while the job was being handed over.
    const latest = await this.port.load();
    if (latest && isTerminal(latest.status)) return latest;
    const running: JobView = { ...view, status: "running" };
    await this.port.save(running);
    await this.port.schedulePoll(POLL_SECONDS);
    return running;
  }

  /** The stored view, refreshed from the container while the job runs; undefined for an unknown job. */
  async status(): Promise<JobView | undefined> {
    const view = await this.port.load();
    if (!view || isTerminal(view.status)) return view;
    if (view.status === "starting") {
      return this.port.now() - view.createdAt > START_GIVE_UP_MS
        ? this.finish(view, "failed", "The job container could not be started")
        : view;
    }
    return this.refresh(view);
  }

  /** Scheduled callback: refresh, and keep polling until the job ends. */
  async poll(): Promise<void> {
    const view = await this.status();
    if (view && !isTerminal(view.status)) await this.port.schedulePoll(POLL_SECONDS);
  }

  async cancel(): Promise<JobView | undefined> {
    const view = await this.port.load();
    if (!view || isTerminal(view.status)) return view;
    if (this.port.isContainerRunning()) {
      try {
        const response = await this.port.fetchContainer("/jobs/current/cancel", { method: "POST" });
        await response.body?.cancel();
      } catch {
        // The container is destroyed below either way.
      }
    }
    return this.finish(view, "canceled", "Canceled by the caller");
  }

  /** The container stopped (crash, eviction, sleepAfter): a running job can no longer finish. */
  async stopped(): Promise<void> {
    const view = await this.port.load();
    if (view && !isTerminal(view.status)) {
      await this.finish(view, "failed", "The job container stopped before the job finished");
    }
  }

  private async refresh(view: JobView): Promise<JobView> {
    if (!this.port.isContainerRunning()) {
      return this.finish(view, "failed", "The job container stopped before the job finished");
    }
    let current: unknown;
    try {
      const response = await this.port.fetchContainer("/jobs/current");
      current = response.ok ? await response.json() : undefined;
    } catch {
      current = undefined;
    }
    if (isCurrentJob(current) && current.state === "done" && current.result) {
      return this.finish(view, current.result.status, undefined, current.result);
    }
    if (isCurrentJob(current) && current.state === "idle") {
      return this.finish(view, "failed", "The job container restarted and lost the job");
    }
    if (this.port.now() - view.createdAt > JOB_GIVE_UP_MS) {
      return this.finish(view, "timed_out", "The job did not report a result in time");
    }
    return view;
  }

  private async finish(
    view: JobView,
    status: JobTerminalStatus,
    error?: string,
    result?: JobResult,
  ): Promise<JobView> {
    const done: JobView = { status, createdAt: view.createdAt, finishedAt: this.port.now() };
    if (result) done.result = result;
    if (error) done.error = error;
    await this.port.save(done);
    try {
      await this.port.releaseSlot();
    } catch {
      // The slot's lease expires on its own.
    }
    try {
      await this.port.destroyContainer();
    } catch {
      // Already stopped; sleepAfter ends it otherwise.
    }
    return done;
  }
}
