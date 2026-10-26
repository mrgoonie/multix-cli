/**
 * Durable Object that owns one multix job and the container it runs in.
 * One instance per job (`MULTIX_JOBS.getByName(jobId)`), so every job gets its
 * own microVM and nothing is shared between accounts. The job server in the
 * image (container/job-server.mjs) listens on 8080.
 *
 * When the job ends, its final view, lifecycle events (events/job-events.ts)
 * and usage record (usage/usage-outbox.ts) are stored in one write and
 * relayed to the owner's AccountEvents and AccountUsage objects by scheduled
 * calls (events/event-outbox.ts).
 *
 * The Worker talks to it over RPC only (startJob / jobStatus / cancelJob);
 * no route forwards outside requests to the container. Only startJob boots
 * the container: requests to the job server go straight to the running
 * container's port and never start a new one (containerFetch would).
 */

import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import type { AccountEventsNamespace } from "../events/account-events.js";
import type { MultixEvent } from "../events/event-catalog.js";
import { OUTBOX_PREFIX, outboxKey, relayOutbox } from "../events/event-outbox.js";
import { jobEvents } from "../events/job-events.js";
import type { AccountUsageNamespace } from "../usage/account-usage.js";
import {
  USAGE_OUTBOX_KEY,
  type UsageOutboxRecord,
  relayUsage,
  settleInputFor,
} from "../usage/usage-outbox.js";
import { type JobQuotaNamespace, durableJobQuota } from "./account-job-quota.js";
import { ContainerCapacityError, JobController } from "./job-controller.js";
import type { JobSpec, JobView } from "./job-protocol.js";
import { JOB_RETENTION_SECONDS } from "./job-protocol.js";

const JOB_KEY = "job";
/** `{ userId, jobId, command }`: the account slot this job holds and what its events report. */
const SLOT_KEY = "slot";
const JOB_SERVER_PORT = 8080;
/** A status or cancel request to the job server never waits longer than this. */
const JOB_SERVER_TIMEOUT_MS = 10_000;

interface JobContainerEnv {
  MULTIX_JOB_QUOTA?: JobQuotaNamespace;
  MULTIX_EVENTS?: AccountEventsNamespace;
  MULTIX_USAGE?: AccountUsageNamespace;
}

interface SlotRecord {
  userId: string;
  jobId: string;
  /** CLI command, e.g. "gemini generate"; absent on jobs started before events existed. */
  command?: string;
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
    saveFinal: async (view) => {
      const slot = await this.ctx.storage.get<SlotRecord>(SLOT_KEY);
      const events =
        slot && this.env.MULTIX_EVENTS
          ? jobEvents({ jobId: slot.jobId, command: slot.command ?? "" }, view)
          : [];
      const usage = slot && this.env.MULTIX_USAGE ? settleInputFor(slot.jobId, view) : undefined;
      const writes: Record<string, unknown> = { [JOB_KEY]: view };
      for (const event of events) writes[outboxKey(event.id)] = event;
      if (slot && usage) {
        writes[USAGE_OUTBOX_KEY] = {
          userId: slot.userId,
          input: usage,
        } satisfies UsageOutboxRecord;
      }
      // No await between the write and schedule()'s synchronous SQL insert, so the
      // view, the outbox entries and the relay schedules are committed together.
      const saved = this.ctx.storage.put(writes);
      const relay = events.length > 0 ? this.scheduleRelay(1, 0) : undefined;
      const relayUsage = usage ? this.scheduleUsageRelay(1, 0) : undefined;
      await saved;
      await relay;
      await relayUsage;
    },
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

  /**
   * Start the job once; `userId` identifies the account slot to give back
   * when it ends and the account its events go to.
   */
  async startJob(spec: JobSpec, userId: string, command?: string): Promise<JobView> {
    if (!(await this.ctx.storage.get(JOB_KEY))) {
      const slot: SlotRecord = { userId, jobId: spec.jobId };
      if (command) slot.command = command;
      await this.ctx.storage.put(SLOT_KEY, slot);
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

  /** Scheduled: hand the job's stored events to the owner's AccountEvents object. */
  async relayEvents(attempt = 1): Promise<void> {
    const events = this.env.MULTIX_EVENTS;
    await relayOutbox(
      {
        list: () => this.ctx.storage.list<MultixEvent>({ prefix: OUTBOX_PREFIX }),
        delete: async (keys) => {
          await this.ctx.storage.delete(keys);
        },
        publish: events
          ? async (list) => {
              const slot = await this.ctx.storage.get<SlotRecord>(SLOT_KEY);
              if (slot) await events.getByName(slot.userId).publish(list);
            }
          : undefined,
        scheduleRelay: (next, seconds) => this.scheduleRelay(next, seconds),
      },
      attempt,
    );
  }

  /** Scheduled: hand the job's usage record to the owner's AccountUsage object. */
  async relayUsage(attempt = 1): Promise<void> {
    const usage = this.env.MULTIX_USAGE;
    await relayUsage(
      {
        load: () => this.ctx.storage.get<UsageOutboxRecord>(USAGE_OUTBOX_KEY),
        remove: async () => {
          await this.ctx.storage.delete(USAGE_OUTBOX_KEY);
        },
        settle: usage ? (record) => usage.getByName(record.userId).settle(record.input) : undefined,
        scheduleRelay: (next, seconds) => this.scheduleUsageRelay(next, seconds),
      },
      attempt,
    );
  }

  private async scheduleUsageRelay(attempt: number, seconds: number): Promise<void> {
    await this.schedule(seconds, "relayUsage" satisfies keyof MultixJobContainer, attempt);
  }

  private async scheduleRelay(attempt: number, seconds: number): Promise<void> {
    await this.schedule(seconds, "relayEvents" satisfies keyof MultixJobContainer, attempt);
  }

  /**
   * Scheduled: drop the job's data once the retention period is over. Only
   * this class's keys are removed; deleteAll() would also drop the
   * schedule table that @cloudflare/containers updates right after this call.
   */
  async expireJob(): Promise<void> {
    const outbox = await this.ctx.storage.list({ prefix: OUTBOX_PREFIX });
    await this.ctx.storage.delete([JOB_KEY, SLOT_KEY, USAGE_OUTBOX_KEY, ...outbox.keys()]);
  }

  override async onStop(_params: StopParams): Promise<void> {
    await this.controller.stopped();
  }
}
