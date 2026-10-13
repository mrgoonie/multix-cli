/**
 * Job ownership in ACCOUNTS_KV: `job:<jobId>` -> { userId, command, createdAt },
 * kept for the job retention period. Status and cancel calls answer only the
 * account that started the job; any other caller gets "not found".
 */

import { JOB_RETENTION_SECONDS, type JobView } from "./job-protocol.js";
import type { JobSpec } from "./job-protocol.js";

export interface JobRecord {
  userId: string;
  command: string;
  createdAt: number;
}

/** crypto.randomUUID() output. */
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(jobId: string): string {
  return `job:${jobId}`;
}

export class JobStore {
  constructor(private readonly kv: KVNamespace) {}

  async create(jobId: string, record: JobRecord): Promise<void> {
    await this.kv.put(key(jobId), JSON.stringify(record), {
      expirationTtl: JOB_RETENTION_SECONDS,
    });
  }

  /** The record when `userId` started the job, otherwise null (unknown, expired or someone else's). */
  async ownedBy(jobId: string, userId: string): Promise<JobRecord | null> {
    if (!JOB_ID_RE.test(jobId)) return null;
    const record = await this.kv.get<JobRecord>(key(jobId), { type: "json" });
    return record && record.userId === userId ? record : null;
  }
}

/** Where jobs run: the per-job Durable Object in production, a stub in tests. */
export interface JobBackend {
  /** Start the job; `userId` owns the account job slot the job gives back when it ends. */
  start(jobId: string, spec: JobSpec, userId: string): Promise<JobView>;
  status(jobId: string): Promise<JobView | null>;
  cancel(jobId: string): Promise<JobView | null>;
}

/** RPC surface of MultixJobContainer used by the Worker. */
export interface JobContainerStub {
  startJob(spec: JobSpec, userId: string): Promise<JobView>;
  jobStatus(): Promise<JobView | null>;
  cancelJob(): Promise<JobView | null>;
}

export interface JobNamespace {
  getByName(name: string): JobContainerStub;
}

export function durableJobBackend(namespace: JobNamespace): JobBackend {
  return {
    start: (jobId, spec, userId) => namespace.getByName(jobId).startJob(spec, userId),
    status: (jobId) => namespace.getByName(jobId).jobStatus(),
    cancel: (jobId) => namespace.getByName(jobId).cancelJob(),
  };
}
