/**
 * Kubernetes Job runner for the self-hosted server (MULTIX_JOB_EXECUTOR=kubernetes):
 * each job runs as its own Kubernetes Job, one pod running the job container
 * (worker/container/Dockerfile, job-server.mjs), instead of a child process of
 * the server. It plugs into local-executor.mjs as its `runJob`, so the
 * executor's rules stay the same: concurrency cap, durable job records
 * without secrets, one final state per job, cancel, and restart recovery
 * (a job left running is recorded as interrupted and never run again).
 *
 * A job, step by step:
 *  1. Create Job `multix-job-<job id>` (backoffLimit 0, restartPolicy Never:
 *     Kubernetes never starts a second pod, so a billed provider call is not
 *     repeated by a retry). Its pod has no service account token, no service
 *     links, a read-only root file system, no capabilities and a size-limited
 *     /tmp, and is labelled so the egress NetworkPolicy selects it.
 *  2. Wait until the pod is Ready (job-server answers GET /).
 *  3. POST the spec to http://<pod IP>:8080/jobs, once. The spec carries the
 *     caller's provider keys: it is never written to a Kubernetes object, a
 *     log or the job record. A POST is never repeated.
 *  4. Poll GET /jobs/current until the job is done, then return its result.
 *     Only a state carrying this job's id counts, so another job (a POST that
 *     beat ours, or another pod that got the same IP) is never taken for it.
 *  5. Whatever happened: ask job-server to stop the CLI if it still runs
 *     (cancel scoped to this job id), delete the Job, and return only once the
 *     pod is gone (at most 60 s), so the executor slot is held until nothing
 *     of the job runs any more. Cancel and shutdown abort the signal and end
 *     the same way.
 *
 * Network isolation is the NetworkPolicy's job (worker/server/k8s/job-executor.yaml):
 * job pods may reach public addresses and cluster DNS only, never cluster,
 * metadata or control-plane addresses, and only the server may reach their
 * port. The runner refuses to start when that policy is missing or does not
 * select its job pods; it cannot tell whether the cluster's network plugin
 * enforces NetworkPolicy, which the operator must ensure.
 *
 * Kubernetes API calls use the pod's service account (in-cluster config) over
 * node:https with the cluster CA; they and the pod calls deliberately bypass
 * the server's public-fetch guard, as their addresses come from the cluster,
 * never from a caller.
 */

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
export const JOB_PORT = 8080;
export const DEFAULT_NETWORK_POLICY = "multix-job-egress";
export const DEFAULT_INSTANCE = "multix-server";
export const DEFAULT_CPU = "1";
export const DEFAULT_MEMORY = "2Gi";
export const DEFAULT_TMP_SIZE = "2Gi";
/** Pod scheduling, image pull and job-server start-up. */
export const DEFAULT_START_TIMEOUT_MS = 5 * 60_000;
/** On top of spec.timeoutMs, before the runner gives up on a job job-server never finishes. */
const FINISH_GRACE_MS = 2 * 60_000;
/** How long cancel waits for the pod to be gone (job-server stops the CLI within 10 s of SIGTERM). */
const POD_GONE_TIMEOUT_MS = 60_000;
/** Consecutive failed polls of a pod that still exists before the job counts as lost. */
const MAX_POLL_FAILURES = 30;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/** Status polls and cancel: short, so a cancel or shutdown is not held up by a hung pod. */
const POLL_TIMEOUT_MS = 5_000;

export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const LABEL_COMPONENT = "app.kubernetes.io/component";
export const LABEL_INSTANCE = "multix.dev/instance";
export const LABEL_JOB_ID = "multix.dev/job-id";
const MANAGED_BY = "multix-server";
const COMPONENT = "job";

export const START_TIMEOUT_ERROR = "The job pod did not start in time; the job was not run";
export const POD_FAILED_ERROR = "The job pod stopped before the job ran; the job was not run";
export const POD_LOST_ERROR = "The job pod stopped while the job was running";
export const NOT_ACCEPTED_ERROR = "The job pod did not accept the job; the job was not run";
export const JOB_EXISTS_ERROR =
  "A Kubernetes Job for this job id already exists; the job was not run again";
export const RUNNER_TIMEOUT_ERROR = "The job did not finish in time";
export const CANCELED_ERROR = "Canceled by the caller";

const QUANTITY_RE = /^[0-9]+(?:\.[0-9]+)?(?:m|Ki|Mi|Gi|Ti|k|M|G|T)?$/;
const NAME_RE = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
// A Secret name is a DNS subdomain: dot-separated labels, 253 characters at most.
const SUBDOMAIN_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
const LABEL_VALUE_RE = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Settings from the environment; read only when MULTIX_JOB_EXECUTOR=kubernetes.
 *   MULTIX_K8S_JOB_IMAGE           required: the job image (worker/container/Dockerfile)
 *   MULTIX_K8S_NAMESPACE           default: the server pod's own namespace
 *   MULTIX_K8S_JOB_NETWORK_POLICY  default multix-job-egress
 *   MULTIX_K8S_INSTANCE            default multix-server (label value; one per deployment)
 *   MULTIX_K8S_JOB_CPU / _MEMORY / _TMP_SIZE   limits, defaults 1 / 2Gi / 2Gi
 *   MULTIX_K8S_JOB_IMAGE_PULL_SECRETS  optional: comma-separated Secret names the job
 *                                      pods pull the image with (the server never reads them)
 */
export function kubernetesSettingsFromEnv(env = process.env, readNamespace = defaultNamespace) {
  const get = (name) => env[name]?.trim() || undefined;
  const image = get("MULTIX_K8S_JOB_IMAGE");
  if (!image || /\s/.test(image)) {
    throw new Error("MULTIX_JOB_EXECUTOR=kubernetes needs MULTIX_K8S_JOB_IMAGE (the job image)");
  }
  const namespace = get("MULTIX_K8S_NAMESPACE") ?? readNamespace();
  const networkPolicy = get("MULTIX_K8S_JOB_NETWORK_POLICY") ?? DEFAULT_NETWORK_POLICY;
  const instance = get("MULTIX_K8S_INSTANCE") ?? DEFAULT_INSTANCE;
  for (const [name, value] of [
    ["MULTIX_K8S_NAMESPACE", namespace],
    ["MULTIX_K8S_JOB_NETWORK_POLICY", networkPolicy],
  ]) {
    if (!value || !NAME_RE.test(value)) throw new Error(`${name} must be a Kubernetes name`);
  }
  if (!LABEL_VALUE_RE.test(instance)) {
    throw new Error("MULTIX_K8S_INSTANCE must be a Kubernetes label value");
  }
  const imagePullSecrets = (get("MULTIX_K8S_JOB_IMAGE_PULL_SECRETS") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of imagePullSecrets) {
    if (!SUBDOMAIN_RE.test(name)) {
      throw new Error(
        `MULTIX_K8S_JOB_IMAGE_PULL_SECRETS: "${name}" is not a Kubernetes Secret name`,
      );
    }
  }
  const quantity = (name, fallback) => {
    const value = get(name) ?? fallback;
    if (!QUANTITY_RE.test(value)) throw new Error(`${name} must be a Kubernetes quantity`);
    return value;
  };
  return {
    image,
    namespace,
    networkPolicy,
    instance,
    cpu: quantity("MULTIX_K8S_JOB_CPU", DEFAULT_CPU),
    memory: quantity("MULTIX_K8S_JOB_MEMORY", DEFAULT_MEMORY),
    tmpSize: quantity("MULTIX_K8S_JOB_TMP_SIZE", DEFAULT_TMP_SIZE),
    imagePullSecrets: [...new Set(imagePullSecrets)],
  };
}

function defaultNamespace() {
  try {
    return readFileSync(`${SERVICE_ACCOUNT_DIR}/namespace`, "utf8").trim();
  } catch {
    throw new Error(
      "MULTIX_K8S_NAMESPACE is not set and the service account namespace file is missing",
    );
  }
}

export class KubernetesApiError extends Error {
  constructor(status, method, path) {
    super(`Kubernetes API ${method} ${path.split("?")[0]} answered ${status}`);
    this.name = "KubernetesApiError";
    this.status = status;
  }
}

/** Send one HTTP(S) request and read a JSON body of at most MAX_RESPONSE_BYTES. */
function sendJson(send, url, { method, headers = {}, body, ca, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = send(
      url,
      {
        method,
        ca,
        timeout: timeoutMs,
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("Response too large"));
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body: json });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Kubernetes API client from the pod's service account. The token is read
 * again for every call: projected service account tokens are rotated.
 * @returns {(method: string, path: string, body?: object) => Promise<{ status: number, body: any }>}
 */
export function inClusterKubernetesApi(env = process.env, dir = SERVICE_ACCOUNT_DIR) {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT || "443";
  if (!host) throw new Error("KUBERNETES_SERVICE_HOST is not set: the server is not in a cluster");
  const ca = readFileSync(`${dir}/ca.crt`);
  const base = `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return (method, path, body) =>
    sendJson(httpsRequest, `${base}${path}`, {
      method,
      body,
      ca,
      headers: { authorization: `Bearer ${readFileSync(`${dir}/token`, "utf8").trim()}` },
    });
}

/** Plain HTTP to a job pod's job-server. */
export function podHttp(ip, method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return sendJson(httpRequest, `http://${host}:${JOB_PORT}${path}`, { method, body, timeoutMs });
}

/** Labels of every job pod of this server deployment; the NetworkPolicy selects by them. */
export function jobPodLabels(instance) {
  return {
    [LABEL_MANAGED_BY]: MANAGED_BY,
    [LABEL_COMPONENT]: COMPONENT,
    [LABEL_INSTANCE]: instance,
  };
}

export function jobName(jobId) {
  return `multix-job-${jobId}`;
}

/** The Job object. Holds no secret: the spec is sent to the pod over HTTP. */
export function jobManifest(settings, spec) {
  const labels = { ...jobPodLabels(settings.instance), [LABEL_JOB_ID]: spec.jobId };
  // Kubernetes stops the pod after this long even if the server is gone.
  const activeDeadlineSeconds =
    Math.ceil((DEFAULT_START_TIMEOUT_MS + spec.timeoutMs + FINISH_GRACE_MS) / 1000) + 60;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobName(spec.jobId), labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 15,
          // Only the Secret names: the kubelet reads them to pull the image.
          ...(settings.imagePullSecrets?.length
            ? { imagePullSecrets: settings.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "job",
              image: settings.image,
              ports: [{ name: "job", containerPort: JOB_PORT, protocol: "TCP" }],
              env: [{ name: "PORT", value: String(JOB_PORT) }],
              readinessProbe: {
                httpGet: { path: "/", port: JOB_PORT },
                periodSeconds: 1,
                failureThreshold: 3,
              },
              resources: {
                requests: { cpu: settings.cpu, memory: settings.memory },
                limits: { cpu: settings.cpu, memory: settings.memory },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: { sizeLimit: settings.tmpSize } }],
        },
      },
    },
  };
}

function selector(labels) {
  return encodeURIComponent(
    Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(","),
  );
}

function podReady(pod) {
  return (
    pod?.status?.phase === "Running" &&
    typeof pod.status.podIP === "string" &&
    (pod.status.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True")
  );
}

const failedResult = (error, status = "failed") => ({
  status,
  exitCode: null,
  stdout: "",
  stderrTail: "",
  outputs: [],
  error,
});

/**
 * @param {{
 *   settings: ReturnType<typeof kubernetesSettingsFromEnv>,
 *   kube: (method: string, path: string, body?: object) => Promise<{ status: number, body: any }>,
 *   pod?: (ip: string, method: string, path: string, body?: object) => Promise<{ status: number, body: any }>,
 *   pollMs?: number,
 *   startTimeoutMs?: number,
 * }} options  `pod`, `pollMs` and `startTimeoutMs` are replaced in tests.
 */
export function createKubernetesJobRunner(options) {
  const { settings, kube } = options;
  const pod = options.pod ?? podHttp;
  const pollMs = options.pollMs ?? 1_000;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const ns = encodeURIComponent(settings.namespace);
  const jobsPath = `/apis/batch/v1/namespaces/${ns}/jobs`;
  const podsPath = `/api/v1/namespaces/${ns}/pods`;
  const ownLabels = jobPodLabels(settings.instance);

  async function api(method, path, body, okStatuses = [200, 201, 202]) {
    const response = await kube(method, path, body);
    if (!okStatuses.includes(response.status)) {
      throw new KubernetesApiError(response.status, method, path);
    }
    return response.body;
  }

  async function podsOf(jobId) {
    const list = await api(
      "GET",
      `${podsPath}?labelSelector=${selector({ ...ownLabels, [LABEL_JOB_ID]: jobId })}`,
    );
    return Array.isArray(list?.items) ? list.items : [];
  }

  async function deleteJob(jobId) {
    try {
      await api(
        "DELETE",
        `${jobsPath}/${jobName(jobId)}?propagationPolicy=Background`,
        undefined,
        [200, 202, 404],
      );
    } catch {
      // ttlSecondsAfterFinished and activeDeadlineSeconds still remove it.
    }
  }

  /** Wait until no pod of the job is left, at most POD_GONE_TIMEOUT_MS. */
  async function waitPodsGone(jobId) {
    const giveUpAt = Date.now() + POD_GONE_TIMEOUT_MS;
    while (Date.now() < giveUpAt) {
      try {
        if ((await podsOf(jobId)).length === 0) return;
      } catch {
        // The API is briefly unreachable: try again.
      }
      await sleep(pollMs);
    }
  }

  /**
   * End the job's pod: ask job-server to stop the CLI (only if this job is the
   * one it runs), delete the Job, and wait until its pod is gone, so the
   * executor slot stays taken while anything of the job still runs.
   */
  async function stop(jobId, ip) {
    // In parallel: on shutdown the Job deletion must not wait behind a hung pod.
    await Promise.all([
      ip
        ? pod(ip, "POST", `/jobs/current/cancel?jobId=${jobId}`, undefined, POLL_TIMEOUT_MS).catch(
            () => {},
          )
        : undefined,
      deleteJob(jobId),
    ]);
    await waitPodsGone(jobId);
  }

  async function waitReady(jobId, signal) {
    const giveUpAt = Date.now() + startTimeoutMs;
    while (!signal.aborted && Date.now() < giveUpAt) {
      let pods = [];
      try {
        pods = await podsOf(jobId);
      } catch {
        // Try again until the start deadline.
      }
      const ready = pods.find(podReady);
      if (ready) return { ip: ready.status.podIP };
      if (pods.some((p) => p?.status?.phase === "Failed" || p?.status?.phase === "Succeeded")) {
        return { error: POD_FAILED_ERROR };
      }
      await sleep(pollMs, signal);
    }
    return signal.aborted ? { aborted: true } : { error: START_TIMEOUT_ERROR };
  }

  async function podStillThere(jobId) {
    try {
      const pods = await podsOf(jobId);
      return pods.some((p) => p?.status?.phase === "Running" || p?.status?.phase === "Pending");
    } catch {
      return true;
    }
  }

  async function runJob(spec, { signal }) {
    const jobId = spec.jobId;
    try {
      const created = await kube("POST", jobsPath, jobManifest(settings, spec));
      if (created.status === 409) return failedResult(JOB_EXISTS_ERROR);
      if (created.status !== 201 && created.status !== 200 && created.status !== 202) {
        throw new KubernetesApiError(created.status, "POST", jobsPath);
      }
    } catch (error) {
      // Nothing may have been created, but make sure no pod of this job is left.
      await deleteJob(jobId);
      throw error;
    }
    let ip;
    try {
      const ready = await waitReady(jobId, signal);
      if (ready.aborted) return failedResult(CANCELED_ERROR, "canceled");
      if (ready.error) return failedResult(ready.error);
      ip = ready.ip;

      // Sent once and never repeated: a second POST could start a second billed call.
      // 409 means the pod already holds a job that is not this POST's: never ours.
      let accepted = false;
      try {
        const response = await pod(ip, "POST", "/jobs", spec);
        if (response.status === 409) return failedResult(NOT_ACCEPTED_ERROR);
        accepted = response.status === 202;
      } catch {
        // The answer was lost; /jobs/current tells whether the job started.
      }

      const giveUpAt = Date.now() + spec.timeoutMs + FINISH_GRACE_MS;
      let failures = 0;
      while (!signal.aborted) {
        if (Date.now() > giveUpAt) return failedResult(RUNNER_TIMEOUT_ERROR, "timed_out");
        let current;
        try {
          const response = await pod(ip, "GET", "/jobs/current", undefined, POLL_TIMEOUT_MS);
          if (response.status === 200) current = response.body;
        } catch {
          current = undefined;
        }
        const state = current?.state;
        // Only this job's own state counts: a different id is another job (or another pod at this IP).
        if ((state === "running" || state === "done") && current.jobId !== jobId) {
          return failedResult(NOT_ACCEPTED_ERROR);
        }
        if (state === "done" && current.result && typeof current.result === "object") {
          return current.result;
        }
        if (state === "idle" && !accepted) return failedResult(NOT_ACCEPTED_ERROR);
        if (state === "running" || state === "idle") {
          failures = 0;
        } else if (++failures >= MAX_POLL_FAILURES || !(await podStillThere(jobId))) {
          return failedResult(POD_LOST_ERROR);
        }
        await sleep(pollMs, signal);
      }
      return failedResult(CANCELED_ERROR, "canceled");
    } finally {
      // Every way out, success included, ends the pod and waits until it is gone.
      await stop(jobId, ip);
    }
  }

  return {
    runJob,

    /**
     * Refuse to start unless the NetworkPolicy exists, selects this server's
     * job pods and restricts both their ingress and egress.
     */
    async verify() {
      const name = settings.networkPolicy;
      let policy;
      try {
        policy = await api(
          "GET",
          `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${encodeURIComponent(name)}`,
        );
      } catch (error) {
        if (error instanceof KubernetesApiError && error.status === 404) {
          throw new Error(
            `NetworkPolicy ${name} is missing in namespace ${settings.namespace}: apply worker/server/k8s/job-executor.yaml before enabling the Kubernetes executor`,
          );
        }
        throw error;
      }
      const match = policy?.spec?.podSelector?.matchLabels ?? {};
      const types = policy?.spec?.policyTypes ?? [];
      const selects =
        Object.keys(match).length > 0 &&
        Object.entries(match).every(([k, v]) => ownLabels[k] === v) &&
        (policy?.spec?.podSelector?.matchExpressions ?? []).length === 0;
      if (!selects || !types.includes("Egress") || !types.includes("Ingress")) {
        throw new Error(
          `NetworkPolicy ${name} must select the job pods by matchLabels (${Object.entries(
            ownLabels,
          )
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}) and list both Ingress and Egress in policyTypes`,
        );
      }
    },

    /**
     * Delete every Job of this server deployment. Called at start-up, after the
     * executor holds its state directory and before any job starts: such Jobs
     * belong to the previous server process, whose jobs are recorded as interrupted.
     * @returns {Promise<number>} how many Jobs were found
     */
    async removeLeftoverJobs() {
      const list = await api("GET", `${jobsPath}?labelSelector=${selector(ownLabels)}`);
      const items = Array.isArray(list?.items) ? list.items : [];
      for (const item of items) {
        const jobId = item?.metadata?.labels?.[LABEL_JOB_ID];
        if (typeof jobId === "string" && /^[0-9a-f-]{36}$/.test(jobId)) await deleteJob(jobId);
      }
      return items.length;
    },
  };
}
