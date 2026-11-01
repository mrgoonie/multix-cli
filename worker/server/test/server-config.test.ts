/** Server-only settings parsed from the environment, and what reaches the Worker env. */

import { describe, expect, it } from "vitest";
import { serverConfigFrom, workerVars } from "../server-config.js";

describe("serverConfigFrom", () => {
  it("runs jobs as child processes unless the Kubernetes executor is chosen", () => {
    expect(serverConfigFrom({}).jobExecutor).toBe("local");
    expect(serverConfigFrom({ MULTIX_JOB_EXECUTOR: "local" }).jobExecutor).toBe("local");
    expect(
      serverConfigFrom({ MULTIX_LOCAL_JOBS: "true", MULTIX_JOB_EXECUTOR: "Kubernetes" })
        .jobExecutor,
    ).toBe("kubernetes");
    // Without jobs on, the executor setting would be silently ignored: refuse it.
    expect(() => serverConfigFrom({ MULTIX_JOB_EXECUTOR: "kubernetes" })).toThrow(
      /needs MULTIX_LOCAL_JOBS=true/,
    );
    expect(() => serverConfigFrom({ MULTIX_JOB_EXECUTOR: "docker" })).toThrow(
      /local or kubernetes/,
    );
  });
});

describe("workerVars", () => {
  it("keeps executor and Kubernetes settings out of the Worker env", () => {
    const vars = workerVars({
      MULTIX_PUBLIC_URL: "https://multix.example.com",
      MULTIX_JOB_EXECUTOR: "kubernetes",
      MULTIX_K8S_JOB_IMAGE: "img:1",
      MULTIX_K8S_NAMESPACE: "multix",
    });
    expect(vars).toEqual({ MULTIX_PUBLIC_URL: "https://multix.example.com" });
  });
});
