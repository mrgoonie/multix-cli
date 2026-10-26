/**
 * One list of models for a task: verified registry entries, checked against
 * the provider catalogs that could be read, plus catalog models multix has
 * not verified. Nothing is reported as available unless a catalog said so;
 * an unread catalog leaves `listed` null (unknown).
 */

import type { DiscoveredModel, DiscoverySource, Task } from "./capability-types.js";
import { COMMAND_CAPABILITIES } from "./command-capabilities.js";
import { verifiedModels } from "./model-registry.js";

export interface ModelView {
  provider: string;
  model: string;
  name?: string;
  task: Task;
  /** In the verified registry: inputs and outputs are known (see `multix models --model <id>`). */
  verified: boolean;
  /** multix command that runs it for this task, or null when none is known to. */
  command: string | null;
  /** Generic runner that passes any id of the provider (no task or input checks). */
  runner?: string;
  /** In the provider catalog now; null when the catalog was not read. */
  listed: boolean | null;
  /** Provider-reported status, or "missing" for a verified model the catalog no longer lists. */
  status?: string;
  voices?: number;
  pricing?: Record<string, string>;
  note?: string;
}

/** A command of `provider` that takes any catalog id for `task`, if one exists. */
export function catalogCommand(provider: string, task: Task): string | null {
  for (const [command, cap] of Object.entries(COMMAND_CAPABILITIES)) {
    if (
      command.split(" ")[0] === provider &&
      cap.models === "provider-catalog" &&
      cap.tasks.includes(task)
    ) {
      return command;
    }
  }
  return null;
}

/** The provider's generic runner (`fal run`), which takes any id but checks nothing. */
export function genericRunner(provider: string): string | undefined {
  return Object.entries(COMMAND_CAPABILITIES).find(
    ([command, cap]) =>
      command.split(" ")[0] === provider &&
      cap.models === "provider-catalog" &&
      cap.tasks.includes("any"),
  )?.[0];
}

export interface CatalogResult {
  source: DiscoverySource;
  models: DiscoveredModel[];
}

export function mergeModelViews(
  task: Task,
  catalogs: CatalogResult[],
  provider?: string,
): ModelView[] {
  const read = new Map(
    catalogs
      .filter((c) => c.source.state !== "unavailable" && c.source.state !== "unsupported")
      .map((c) => [c.source.provider, c.models]),
  );
  const truncated = new Set(
    catalogs.filter((c) => c.source.truncated).map((c) => c.source.provider),
  );
  const views: ModelView[] = [];
  const seen = new Set<string>();
  for (const cap of verifiedModels({ task, ...(provider ? { provider } : {}) })) {
    const listing = read.get(cap.provider);
    const found = listing?.find((m) => m.model === cap.model);
    seen.add(`${cap.provider}\n${cap.model}`);
    views.push({
      provider: cap.provider,
      model: cap.model,
      name: cap.name,
      task,
      verified: true,
      command: cap.command,
      // A truncated catalog cannot prove absence: unknown, not missing.
      listed: found ? true : listing && !truncated.has(cap.provider) ? false : null,
      ...(found?.status
        ? { status: found.status }
        : listing && !found && !truncated.has(cap.provider)
          ? {
              status: "missing",
              note: "not in the provider catalog: removed or renamed; do not run it until re-verified",
            }
          : {}),
      ...(cap.deprecated ? { status: "deprecated" } : {}),
    });
  }
  for (const c of catalogs) {
    for (const m of c.models) {
      if (seen.has(`${m.provider}\n${m.model}`)) continue;
      seen.add(`${m.provider}\n${m.model}`);
      const command = catalogCommand(m.provider, task);
      const runner = command ? undefined : genericRunner(m.provider);
      views.push({
        provider: m.provider,
        model: m.model,
        ...(m.name ? { name: m.name } : {}),
        task,
        verified: false,
        command,
        ...(runner ? { runner } : {}),
        listed: true,
        ...(m.status ? { status: m.status } : {}),
        ...(m.voices?.length ? { voices: m.voices.length } : {}),
        ...(m.pricing ? { pricing: m.pricing } : {}),
        note: command
          ? `unverified: ${command} passes the id through; check the model's inputs first`
          : runner
            ? `unverified: ${runner} passes any id, but its inputs are unknown to multix`
            : `no multix command runs ${m.provider} ${task} models yet`,
      });
    }
  }
  return views;
}
