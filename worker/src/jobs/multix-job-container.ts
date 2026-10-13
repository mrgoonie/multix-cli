/**
 * Durable Object that owns one multix job and the container it runs in.
 * One instance per job (`MULTIX_JOBS.getByName(jobId)`), so every job gets its
 * own microVM and nothing is shared between accounts. The job server in the
 * image (container/job-server.mjs) listens on 8080.
 *
 * The Worker talks to it over RPC only (startJob / jobStatus / cancelJob);
 * no route forwards outside requests to the container.
 */

import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import { JobController } from "./job-controller.js";
import type { JobSpec, JobView } from "./job-protocol.js";
import { JOB_RETENTION_SECONDS } from "./job-protocol.js";

const JOB_KEY = "job";
const JOB_SERVER_PORT = 8080;

export class MultixJobContainer extends Container {
  override defaultPort = JOB_SERVER_PORT;
  /** Longer than the CLI timeout (30 min); the job destroys the container as soon as it ends. */
  override sleepAfter = "40m";

  private readonly controller = new JobController({
    load: () => this.ctx.storage.get<JobView>(JOB_KEY),
    save: (view) => this.ctx.storage.put(JOB_KEY, view),
    startContainer: () =>
      this.startAndWaitForPorts({
        ports: JOB_SERVER_PORT,
        cancellationOptions: { portReadyTimeoutMS: 60_000 },
      }),
    fetchContainer: (path, init) => this.containerFetch(`http://container${path}`, init),
    destroyContainer: () => this.destroy(),
    schedulePoll: async (seconds) => {
      await this.schedule(seconds, "pollJob");
    },
    now: () => Date.now(),
  });

  async startJob(spec: JobSpec): Promise<JobView> {
    const view = await this.controller.start(spec);
    await this.schedule(JOB_RETENTION_SECONDS, "expireJob");
    return view;
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

  /** Scheduled: drop the stored result once the retention period is over. */
  async expireJob(): Promise<void> {
    await this.ctx.storage.delete(JOB_KEY);
  }

  override async onStop(_params: StopParams): Promise<void> {
    await this.controller.stopped();
  }
}
