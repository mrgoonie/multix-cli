import { describe, expect, it } from "vitest";
import { fakeNamespace, fakeQuotaNamespace } from "./fake-job-bindings.js";
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
