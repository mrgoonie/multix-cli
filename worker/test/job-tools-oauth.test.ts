import { describe, expect, it } from "vitest";
import { AccountJobQuota, type JobQuotaNamespace } from "../src/jobs/account-job-quota.js";
import type { JobSpec, JobView } from "../src/jobs/job-protocol.js";
import type { JobContainerStub, JobNamespace } from "../src/jobs/job-store.js";
import {
  authorizeAndGetToken,
  githubFetch,
  hiddenField,
  mcpCall,
  newBrowser,
  oauthEnv,
  registerClient,
} from "./oauth-harness.js";

const OCTOCAT = { id: 1, login: "octocat" };
const GEMINI_KEY = "AIza-gemini-secret-value-1234";

/** MULTIX_JOBS stand-in: one stub per job name, finishing as soon as it starts. */
function fakeNamespace() {
  const specs = new Map<string, JobSpec>();
  const namespace: JobNamespace = {
    getByName(name: string): JobContainerStub {
      const done = (): JobView => ({
        status: "succeeded",
        createdAt: 1,
        finishedAt: 2,
        result: {
          status: "succeeded",
          exitCode: 0,
          stdout: `key=${specs.get(name)?.env.GEMINI_API_KEY}`,
          stderrTail: "",
          outputs: [],
        },
      });
      return {
        startJob: async (spec) => {
          specs.set(name, spec);
          return done();
        },
        jobStatus: async () => (specs.has(name) ? done() : null),
        cancelJob: async () => null,
      };
    },
  };
  return { namespace, specs };
}

/** MULTIX_JOB_QUOTA stand-in: the real AccountJobQuota class over in-memory storage. */
function fakeQuotaNamespace(): JobQuotaNamespace {
  const objects = new Map<string, AccountJobQuota>();
  return {
    getByName(name: string) {
      let quota = objects.get(name);
      if (!quota) {
        const data = new Map<string, unknown>();
        const storage = {
          get: async (key: string) => structuredClone(data.get(key)),
          put: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
        };
        quota = new AccountJobQuota({ storage } as never, {} as never);
        objects.set(name, quota);
      }
      return quota;
    },
  };
}

async function toolResult(response: Response) {
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

describe("CLI runner through OAuth", () => {
  it("runs a job with the signed-in account's own keys and records its ownership", async () => {
    const { namespace, specs } = fakeNamespace();
    const env = oauthEnv({ MULTIX_JOBS: namespace, MULTIX_JOB_QUOTA: fakeQuotaNamespace() });
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));
    const dashboard = await (await browser.request("/dashboard")).text();
    await browser.post("/dashboard/secrets", {
      csrf: hiddenField(dashboard, "csrf"),
      name: "GEMINI_API_KEY",
      value: GEMINI_KEY,
      intent: "save",
    });

    const run = await toolResult(
      await mcpCall(browser, token, "tools/call", {
        name: "multix_run",
        arguments: { command: "gemini generate", options: { prompt: "a cat" } },
      }),
    );
    const payload = run.structuredContent as { job_id: string; stdout: string; status: string };
    expect(payload.status).toBe("succeeded");
    expect(payload.stdout).toBe("key=[redacted]");
    expect(specs.get(payload.job_id)?.env).toEqual({ GEMINI_API_KEY: GEMINI_KEY });

    const kv = (env.ACCOUNTS_KV as unknown as { dump(): Map<string, { value: string }> }).dump();
    const record = JSON.parse(kv.get(`job:${payload.job_id}`)?.value ?? "null");
    expect(record).toMatchObject({ userId: "gh-1", command: "gemini generate" });
    expect(JSON.stringify([...kv])).not.toContain(GEMINI_KEY);

    const status = await toolResult(
      await mcpCall(browser, token, "tools/call", {
        name: "multix_job_status",
        arguments: { job_id: payload.job_id },
      }),
    );
    expect((status.structuredContent as { status: string }).status).toBe("succeeded");
  });
});
