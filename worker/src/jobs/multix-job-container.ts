/**
 * Durable Object that owns one multix job and the container it runs in.
 * One instance per job (`MULTIX_JOBS.getByName(jobId)`), so every job gets its
 * own microVM and nothing is shared between accounts. The job server in the
 * image (container/job-server.mjs) listens on 8080.
 *
 * The Worker talks to it over RPC only (startJob / jobStatus / cancelJob);
 * no route forwards outside requests to the container. Only startJob boots
 * the container: requests to the job server go straight to the running
 * container's port and never start a new one (containerFetch would).
 */

import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import { type JobQuotaNamespace, durableJobQuota } from "./account-job-quota.js";
import { ContainerCapacityError, JobController } from "./job-controller.js";
import type { JobSpec, JobView } from "./job-protocol.js";
import { JOB_RETENTION_SECONDS } from "./job-protocol.js";

const JOB_KEY = "job";
/** `{ userId, jobId }` of the account slot this job holds. */
const SLOT_KEY = "slot";
const JOB_SERVER_PORT = 8080;
/** A status or cancel request to the job server never waits longer than this. */
const JOB_SERVER_TIMEOUT_MS = 10_000;

interface JobContainerEnv {
  MULTIX_JOB_QUOTA?: JobQuotaNamespace;
}

interface SlotRecord {
  userId: string;
  jobId: string;
}

/** Errors @cloudflare/containers raises when no instance can be had (max_instances, rate limit). */
function isCapacityError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("no container instance") || message.includes("too many containers per second")
  );
}

export class MultixJobContainer extends Container<JobContainerEnv> {
  override defaultPort = JOB_SERVER_PORT;
  /** Longer than the job's give-up time (35 min); the job destroys the container as soon as it ends. */
  override sleepAfter = "40m";

  private readonly controller = new JobController({
    load: () => this.ctx.storage.get<JobView>(JOB_KEY),
    save: (view) => this.ctx.storage.put(JOB_KEY, view),
    startContainer: async () => {
      try {
        await this.startAndWaitForPorts({
          ports: JOB_SERVER_PORT,
          cancellationOptions: { instanceGetTimeoutMS: 15_000, portReadyTimeoutMS: 30_000 },
        });
      } catch (error) {
        throw isCapacityError(error) ? new ContainerCapacityError() : error;
      }
    },
    isContainerRunning: () => Boolean(this.ctx.container?.running),
    fetchContainer: async (path, init) => {
      const container = this.ctx.container;
      if (!container?.running) throw new Error("The job container is not running");
      this.renewActivityTimeout();
      const signal = init?.signal ?? AbortSignal.timeout(JOB_SERVER_TIMEOUT_MS);
      return container
        .getTcpPort(JOB_SERVER_PORT)
        .fetch(`http://container${path}`, { ...init, signal });
    },
    destroyContainer: () => this.destroy(),
    schedulePoll: async (seconds) => {
      await this.schedule(seconds, "pollJob");
    },
    releaseSlot: async () => {
      const slot = await this.ctx.storage.get<SlotRecord>(SLOT_KEY);
      const quota = this.env.MULTIX_JOB_QUOTA;
      if (slot && quota) await durableJobQuota(quota).release(slot.userId, slot.jobId);
    },
    scheduleSlotRelease: async (attempt, seconds) => {
      await this.schedule(seconds, "retrySlotRelease" satisfies keyof MultixJobContainer, attempt);
    },
    now: () => Date.now(),
  });

  /** Start the job once; `userId` identifies the account slot to give back when it ends. */
  async startJob(spec: JobSpec, userId: string): Promise<JobView> {
    if (!(await this.ctx.storage.get(JOB_KEY))) {
      await this.ctx.storage.put(SLOT_KEY, { userId, jobId: spec.jobId } satisfies SlotRecord);
      await this.schedule(JOB_RETENTION_SECONDS, "expireJob");
    }
    return this.controller.start(spec);
  }

  async jobStatus(): Promise<JobView | null> {
    return (await this.controller.status()) ?? null;
  }

  async cancelJob(): Promise<JobView | null> {
    return (await this.controller.cancel()) ?? null;
  }

  /** Scheduled: keep polling the job server until the job ends. */
  async pollJob(): Promise<void> {
    await this.controller.poll();
  }

  /** Scheduled: try again to give back the job's quota slots after a failed release. */
  async retrySlotRelease(attempt: number): Promise<void> {
    await this.controller.releaseSlot(attempt);
  }

  /**
   * Scheduled: drop the job's data once the retention period is over. Only
   * this class's keys are removed; deleteAll() would also drop the
   * schedule table that @cloudflare/containers updates right after this call.
   */
  async expireJob(): Promise<void> {
    await this.ctx.storage.delete([JOB_KEY, SLOT_KEY]);
  }

  override async onStop(_params: StopParams): Promise<void> {
    await this.controller.stopped();
  }
}
