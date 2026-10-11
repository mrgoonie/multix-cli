/**
 * multix replicate run <model> — run any Replicate model with a raw JSON input.
 * `owner/name` uses the official-model endpoint; `owner/name:version`, a bare
 * version id, or `--version` uses the versioned predictions endpoint.
 */

import type { Command } from "commander";
import { parseJsonInput } from "../../../core/json-input.js";
import { createLogger } from "../../../core/logger.js";
import { parseModelRef } from "../models.js";
import { createReplicateClient } from "../node-client.js";
import { parseFileAssignments, resolveFileInput } from "../node-input-files.js";
import { type FlowOptions, addFlowOptions, executePrediction } from "./prediction-flow.js";

const collect = (value: string, previous: string[] = []) => [...previous, value];

export function registerReplicateRunCommand(parent: Command): void {
  const cmd = parent
    .command("run <model>")
    .description(
      "Run any Replicate model: owner/name (official), owner/name:version, or a version id",
    )
    .requiredOption("--input <json>", "Model input as JSON, or @path/to/input.json")
    .option("--version <id>", "Explicit model version id (uses the versioned endpoint)")
    .option(
      "--file <key=path>",
      "Set input <key> to a local file or URL (uploaded if needed); repeatable",
      collect,
    );
  addFlowOptions(cmd, 600_000).action(
    async (
      model: string,
      opts: FlowOptions & { input: string; version?: string; file?: string[] },
    ) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const ref = parseModelRef(model, opts.version);
      const input = parseJsonInput(opts.input);
      const files = parseFileAssignments(opts.file);
      const client = createReplicateClient();
      for (const [key, value] of files) {
        input[key] = await resolveFileInput(value, client, logger);
      }
      await executePrediction({ client, model: ref, input, opts, logger });
    },
  );
}
