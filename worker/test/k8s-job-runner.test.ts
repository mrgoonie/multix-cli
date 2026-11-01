/**
 * The Kubernetes Job runner (container/k8s-job-runner.mjs) against a fake
 * Kubernetes API and a fake job pod: settings, the Job manifest (no secret in
 * it), the run / cancel / failure paths, the NetworkPolicy check, leftover
 * cleanup, and its use as the local executor's runJob. No cluster, no network.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: untyped .mjs modules
type Any = any;
const testFileUrl = (import.meta as unknown as { url: string }).url;
const load = (rel: string): Promise<Any> =>
  import(/* @vite-ignore */ decodeURIComponent(new URL(rel, testFileUrl).pathname));
const k8s = () => load("../container/k8s-job-runner.mjs");

const KEY = "AIza-gemini-secret-value-1234";
const ID = "11111111-2222-4333-8444-555555555555";
const ID2 = "22222222-2222-4333-8444-555555555555";
const RESULT = { status: "succeeded", exitCode: 0, stdout: "ok", stderrTail: "", outputs: [] };

function spec(jobId = ID) {
  return {
    jobId,
    argv: ["media", "optimize"],
    env: { GEMINI_API_KEY: KEY },
    inputs: [],
    timeoutMs: 20_000,
  };
}

const SETTINGS = {
  image: "registry.example/multix-job:1",
  namespace: "multix",
  networkPolicy: "multix-job-egress",
  instance: "multix-server",
  cpu: "1",
  memory: "2Gi",
  tmpSize: "2Gi",
};

type PodPhase = "Pending" | "Running" | "Failed" | "Succeeded";

/** A fake API server holding Jobs and their pods, plus a fake job-server per pod. */
function fakeCluster() {
  const calls: { method: string; path: string; body?: Any }[] = [];
  const podCalls: { ip: string; method: string; path: string; body?: Any }[] = [];
  const jobs = new Map<string, Any>();
  const pods = new Map<string, { phase: PodPhase; ready: boolean; labels: Any }>();
  const state = {
    /** Polls of the pod list before the pod becomes ready. */
    readyAfter: 1,
    podPhase: "Running" as PodPhase,
    createStatus: 201,
    jobState: "idle" as "idle" | "running" | "done",
    result: RESULT as Any,
    postStatus: 202 as number | "throw",
    /** /jobs/current polls answered "running" before "done". */
    runningPolls: 1,
    policy: undefined as Any,
    podGetFails: false,
    /** Job id job-server reports; defaults to the posted spec's. */
    runningJobId: undefined as string | undefined,
    /** Pod-list polls a deleted Job's pod stays listed (terminating). */
    podLinger: 0,
  };
  let lingering: { name: string; left: number; labels: Any }[] = [];
  let podListPolls = 0;

  async function kube(method: string, path: string, body?: Any) {
    calls.push({ method, path, body });
    const [base = "", query = ""] = path.split("?");
    if (method === "POST" && base.endsWith("/jobs")) {
      if (state.createStatus !== 201) return { status: state.createStatus, body: {} };
      jobs.set(body.metadata.name, body);
      pods.set(body.metadata.name, {
        phase: "Pending",
        ready: false,
        labels: body.spec.template.metadata.labels,
      });
      return { status: 201, body };
    }
    if (method === "DELETE" && base.includes("/jobs/")) {
      const name = base.split("/").pop() as string;
      jobs.delete(name);
      const gone = pods.get(name);
      pods.delete(name);
      if (gone && state.podLinger > 0) {
        lingering.push({ name, left: state.podLinger, labels: gone.labels });
      }
      return { status: 200, body: {} };
    }
    if (method === "GET" && base.endsWith("/jobs")) {
      return { status: 200, body: { items: [...jobs.values()] } };
    }
    if (method === "GET" && base.endsWith("/pods")) {
      podListPolls++;
      const want = Object.fromEntries(
        decodeURIComponent(query.replace("labelSelector=", ""))
          .split(",")
          .map((p) => p.split("=")),
      );
      for (const l of lingering) l.left--;
      const terminating = lingering
        .filter((l) => l.left >= 0 && Object.entries(want).every(([k, v]) => l.labels[k] === v))
        .map(() => ({ status: { phase: "Running", conditions: [] } }));
      lingering = lingering.filter((l) => l.left >= 0);
      const items = [...pods.values()]
        .filter((p) => Object.entries(want).every(([k, v]) => p.labels[k] === v))
        .map((p) => {
          if (p.phase === "Pending" && podListPolls > state.readyAfter) {
            p.phase = state.podPhase;
            p.ready = state.podPhase === "Running";
          }
          return {
            status: {
              phase: p.phase,
              podIP: p.phase === "Running" ? "10.1.2.3" : undefined,
              conditions: [{ type: "Ready", status: p.ready ? "True" : "False" }],
            },
          };
        });
      return { status: 200, body: { items: [...items, ...terminating] } };
    }
    if (method === "GET" && base.includes("/networkpolicies/")) {
      return state.policy ? { status: 200, body: state.policy } : { status: 404, body: {} };
    }
    return { status: 404, body: {} };
  }

  async function pod(ip: string, method: string, path: string, body?: Any) {
    podCalls.push({ ip, method, path, body });
    if (method === "POST" && path === "/jobs") {
      state.runningJobId ??= body.jobId;
      if (state.postStatus === "throw") {
        if (state.jobState === "idle") state.jobState = "running";
        throw new Error("socket hang up");
      }
      if (state.postStatus === 202) state.jobState = "running";
      return { status: state.postStatus, body: {} };
    }
    if (method === "GET" && path === "/jobs/current") {
      if (state.podGetFails) throw new Error("ECONNREFUSED");
      if (state.jobState === "running" && state.runningPolls-- <= 0) state.jobState = "done";
      const id = state.jobState === "idle" ? {} : { jobId: state.runningJobId };
      return {
        status: 200,
        body:
          state.jobState === "done"
            ? { state: "done", ...id, result: state.result }
            : { state: state.jobState, ...id },
      };
    }
    if (method === "POST" && path.startsWith("/jobs/current/cancel")) {
      return { status: 202, body: {} };
    }
    return { status: 404, body: {} };
  }

  return { calls, podCalls, jobs, pods, state, kube, pod };
}

async function runner(cluster: ReturnType<typeof fakeCluster>, extra: Any = {}) {
  const { createKubernetesJobRunner } = await k8s();
  return createKubernetesJobRunner({
    settings: SETTINGS,
    kube: cluster.kube,
    pod: cluster.pod,
    pollMs: 1,
    startTimeoutMs: 200,
    ...extra,
  });
}

describe("kubernetesSettingsFromEnv", () => {
  it("needs the job image and fills in defaults", async () => {
    const { kubernetesSettingsFromEnv } = await k8s();
    expect(() => kubernetesSettingsFromEnv({}, () => "multix")).toThrow(/MULTIX_K8S_JOB_IMAGE/);
    expect(kubernetesSettingsFromEnv({ MULTIX_K8S_JOB_IMAGE: "img:1" }, () => "multix")).toEqual({
      ...SETTINGS,
      image: "img:1",
    });
  });

  it("rejects names, labels and quantities Kubernetes would not accept", async () => {
    const { kubernetesSettingsFromEnv } = await k8s();
    const base = { MULTIX_K8S_JOB_IMAGE: "img:1" };
    const ns = () => "multix";
    expect(() =>
      kubernetesSettingsFromEnv({ ...base, MULTIX_K8S_NAMESPACE: "Bad_NS" }, ns),
    ).toThrow();
    expect(() => kubernetesSettingsFromEnv({ ...base, MULTIX_K8S_INSTANCE: "a b" }, ns)).toThrow();
    expect(() =>
      kubernetesSettingsFromEnv({ ...base, MULTIX_K8S_JOB_MEMORY: "2 GB" }, ns),
    ).toThrow();
    expect(() => kubernetesSettingsFromEnv({ ...base, MULTIX_K8S_JOB_IMAGE: "a b" }, ns)).toThrow();
  });
});

describe("jobManifest", () => {
  it("holds no secret, never retries and locks the pod down", async () => {
    const { jobManifest } = await k8s();
    const manifest = jobManifest(SETTINGS, spec());
    const text = JSON.stringify(manifest);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("GEMINI_API_KEY");
    expect(manifest.metadata.name).toBe(`multix-job-${ID}`);
    expect(manifest.spec.backoffLimit).toBe(0);
    const podSpec = manifest.spec.template.spec;
    expect(podSpec.restartPolicy).toBe("Never");
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.enableServiceLinks).toBe(false);
    expect(podSpec.securityContext.runAsNonRoot).toBe(true);
    const container = podSpec.containers[0];
    expect(container.image).toBe(SETTINGS.image);
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(manifest.spec.template.metadata.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "multix-server",
      "app.kubernetes.io/component": "job",
      "multix.dev/instance": "multix-server",
      "multix.dev/job-id": ID,
    });
    expect(manifest.spec.activeDeadlineSeconds).toBeGreaterThan(spec().timeoutMs / 1000);
  });
});

describe("runJob", () => {
  it("runs the job in its pod, sends the spec once and deletes the Job", async () => {
    const cluster = fakeCluster();
    const r = await runner(cluster);
    const result = await r.runJob(spec(), { signal: new AbortController().signal });
    expect(result).toEqual(RESULT);
    const posts = cluster.podCalls.filter((c) => c.method === "POST" && c.path === "/jobs");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.env.GEMINI_API_KEY).toBe(KEY);
    expect(posts[0]?.ip).toBe("10.1.2.3");
    // The spec never went to the Kubernetes API.
    expect(JSON.stringify(cluster.calls)).not.toContain(KEY);
    expect(cluster.jobs.size).toBe(0);
  });

  it("cancels: stops the CLI, deletes the Job and waits for the pod to go", async () => {
    const cluster = fakeCluster();
    cluster.state.runningPolls = Number.POSITIVE_INFINITY;
    const r = await runner(cluster);
    const abort = new AbortController();
    const done = r.runJob(spec(), { signal: abort.signal });
    while (!cluster.podCalls.some((c) => c.path === "/jobs/current")) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    abort.abort();
    const result = await done;
    expect(result.status).toBe("canceled");
    expect(cluster.podCalls.some((c) => c.path === `/jobs/current/cancel?jobId=${ID}`)).toBe(true);
    expect(cluster.pods.size).toBe(0);
    expect(cluster.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("cancel before the pod is ready never sends the spec", async () => {
    const cluster = fakeCluster();
    cluster.state.readyAfter = Number.POSITIVE_INFINITY;
    const r = await runner(cluster, { startTimeoutMs: 10_000 });
    const abort = new AbortController();
    const done = r.runJob(spec(), { signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    expect((await done).status).toBe("canceled");
    expect(cluster.podCalls).toHaveLength(0);
    expect(cluster.jobs.size).toBe(0);
  });

  it("a pod that fails to start does not run the job", async () => {
    const { POD_FAILED_ERROR } = await k8s();
    const cluster = fakeCluster();
    cluster.state.podPhase = "Failed";
    const result = await (await runner(cluster)).runJob(spec(), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", error: POD_FAILED_ERROR });
    expect(cluster.podCalls).toHaveLength(0);
    expect(cluster.jobs.size).toBe(0);
  });

  it("a pod that never becomes ready times out without running the job", async () => {
    const { START_TIMEOUT_ERROR } = await k8s();
    const cluster = fakeCluster();
    cluster.state.readyAfter = Number.POSITIVE_INFINITY;
    const result = await (await runner(cluster, { startTimeoutMs: 30 })).runJob(spec(), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", error: START_TIMEOUT_ERROR });
    expect(cluster.podCalls).toHaveLength(0);
    expect(cluster.jobs.size).toBe(0);
  });

  it("an existing Job of the same id is never run again", async () => {
    const { JOB_EXISTS_ERROR } = await k8s();
    const cluster = fakeCluster();
    cluster.state.createStatus = 409;
    const result = await (await runner(cluster)).runJob(spec(), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", error: JOB_EXISTS_ERROR });
    expect(cluster.podCalls).toHaveLength(0);
  });

  it("a lost POST answer is not repeated; the job's own state decides", async () => {
    const cluster = fakeCluster();
    cluster.state.postStatus = "throw";
    const result = await (await runner(cluster)).runJob(spec(), {
      signal: new AbortController().signal,
    });
    expect(result).toEqual(RESULT);
    expect(cluster.podCalls.filter((c) => c.path === "/jobs")).toHaveLength(1);
  });

  it("a pod that did not accept the job fails it without a retry", async () => {
    const { NOT_ACCEPTED_ERROR } = await k8s();
    const cluster = fakeCluster();
    cluster.state.postStatus = 400;
    const result = await (await runner(cluster)).runJob(spec(), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", error: NOT_ACCEPTED_ERROR });
    expect(cluster.podCalls.filter((c) => c.path === "/jobs")).toHaveLength(1);
  });

  it("a pod that stops answering while running fails the job as lost", async () => {
    const { POD_LOST_ERROR } = await k8s();
    const cluster = fakeCluster();
    cluster.state.podGetFails = true;
    const result = await (await runner(cluster)).runJob(spec(), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", error: POD_LOST_ERROR });
    expect(cluster.jobs.size).toBe(0);
  });
  it("another job in the pod is never taken for this one", async () => {
    const { NOT_ACCEPTED_ERROR } = await k8s();
    const cluster = fakeCluster();
    cluster.state.postStatus = 409;
    cluster.state.jobState = "running";
    cluster.state.runningJobId = ID2;
    const result = await (await runner(cluster)).runJob(spec(), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", error: NOT_ACCEPTED_ERROR });
    expect(cluster.jobs.size).toBe(0);
  });

  it("a done state of another job id is not returned as this job's result", async () => {
    const { NOT_ACCEPTED_ERROR } = await k8s();
    const cluster = fakeCluster();
    cluster.state.runningJobId = ID2;
    const result = await (await runner(cluster)).runJob(spec(), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", error: NOT_ACCEPTED_ERROR });
  });

  it("holds on until the pod is gone, also when the pod was lost", async () => {
    const { POD_LOST_ERROR } = await k8s();
    const cluster = fakeCluster();
    cluster.state.podGetFails = true;
    cluster.state.podLinger = 3;
    const result = await (await runner(cluster)).runJob(spec(), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", error: POD_LOST_ERROR });
    expect(cluster.podCalls.some((c) => c.path.startsWith("/jobs/current/cancel"))).toBe(true);
    // The last pod-list read saw no pod left before runJob returned.
    const last = await cluster.kube(
      "GET",
      `/api/v1/namespaces/multix/pods?labelSelector=${encodeURIComponent(`multix.dev/job-id=${ID}`)}`,
    );
    expect(last.body.items).toHaveLength(0);
    const podLists = cluster.calls.filter((c) => c.path.includes("/pods?"));
    expect(podLists.length).toBeGreaterThan(3);
  });
});

describe("verify", () => {
  const goodPolicy = {
    spec: {
      podSelector: {
        matchLabels: {
          "app.kubernetes.io/managed-by": "multix-server",
          "app.kubernetes.io/component": "job",
          "multix.dev/instance": "multix-server",
        },
      },
      policyTypes: ["Ingress", "Egress"],
    },
  };

  it("refuses to start without the NetworkPolicy", async () => {
    const cluster = fakeCluster();
    await expect((await runner(cluster)).verify()).rejects.toThrow(/multix-job-egress is missing/);
  });

  it("refuses a policy that does not select the job pods or skips egress", async () => {
    const cluster = fakeCluster();
    const r = await runner(cluster);
    cluster.state.policy = { spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] } };
    await expect(r.verify()).rejects.toThrow(/must select the job pods/);
    cluster.state.policy = {
      spec: { ...goodPolicy.spec, podSelector: { matchLabels: { app: "other" } } },
    };
    await expect(r.verify()).rejects.toThrow(/must select the job pods/);
    cluster.state.policy = { spec: { ...goodPolicy.spec, policyTypes: ["Ingress"] } };
    await expect(r.verify()).rejects.toThrow(/Egress/);
  });

  it("accepts the shipped policy shape", async () => {
    const cluster = fakeCluster();
    cluster.state.policy = goodPolicy;
    await expect((await runner(cluster)).verify()).resolves.toBeUndefined();
  });
});

describe("with the local executor", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("removes the previous process's Jobs at start-up and runs jobs through pods", async () => {
    const cluster = fakeCluster();
    const r = await runner(cluster);
    // A Job left by an earlier server process.
    const { jobManifest } = await k8s();
    const leftover = jobManifest(SETTINGS, spec(ID2));
    cluster.jobs.set(leftover.metadata.name, leftover);

    const dir = await mkdtemp(join(tmpdir(), "multix-k8s-exec-"));
    dirs.push(dir);
    const { createLocalExecutor } = await load("../container/local-executor.mjs");
    const executor = await createLocalExecutor({
      stateDir: dir,
      closeTimeoutMs: 200,
      runJob: (s: Any, o: Any) => r.runJob(s, o),
      startEgressProxy: async () => ({ env: {}, close: async () => {} }),
      prepare: () => r.removeLeftoverJobs(),
    });
    try {
      expect(cluster.jobs.size).toBe(0);
      expect((await executor.start(ID, spec(), "user-1", "media optimize")).status).toBe("running");
      let view: Any;
      for (let i = 0; i < 200; i++) {
        view = await executor.status(ID);
        if (view?.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(view).toMatchObject({ status: "succeeded", result: { stdout: "ok" } });
    } finally {
      await executor.close();
    }
  });

  it("a failing prepare stops start-up and releases the state directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "multix-k8s-exec-"));
    dirs.push(dir);
    const { createLocalExecutor } = await load("../container/local-executor.mjs");
    const noEgress = async () => ({ env: {}, close: async () => {} });
    await expect(
      createLocalExecutor({
        stateDir: dir,
        startEgressProxy: noEgress,
        prepare: async () => {
          throw new Error("API down");
        },
      }),
    ).rejects.toThrow("API down");
    const again = await createLocalExecutor({ stateDir: dir, startEgressProxy: noEgress });
    await again.close();
  });
});
