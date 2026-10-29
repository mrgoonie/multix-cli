import { describe, expect, it } from "vitest";
import { commandCapability } from "../../src/capabilities/command-capabilities.js";
import { buildCliCatalog } from "../scripts/cli-catalog-builder.js";
import { catalogPayload } from "../src/jobs/catalog-view.js";
import { CLI_CATALOG, CatalogIndex, isRepeatable, optionName } from "../src/jobs/cli-catalog.js";
import {
  COMMAND_POLICIES,
  EXCLUDED_COMMANDS,
  GROUP_KEYS,
  OUTPUT_DIR_OPTION,
  OUTPUT_FILE_OPTION,
  policyFor,
} from "../src/jobs/cli-command-policy.js";
import { PROVIDER_SECRET_NAMES } from "../src/provider-secret-names.js";
import { loadCliProgram } from "./cli-program.js";

describe("CLI catalog", () => {
  it("matches the CLI's current commands (run `npm run catalog` in worker/ when this fails)", async () => {
    const program = await loadCliProgram();
    expect(CLI_CATALOG).toEqual(buildCliCatalog(program));
  }, 120_000);

  it("has a policy that only names commands, options and positionals the CLI has", () => {
    const index = new CatalogIndex();
    for (const [path, policy] of Object.entries(COMMAND_POLICIES)) {
      const entry = index.find(path);
      expect(entry, path).toBeDefined();
      const options = new Set(entry?.command.options.map(optionName));
      const positionals = new Set(entry?.command.positionals.map((p) => p.name));
      const named = [
        ...Object.keys(policy.fileOptions ?? {}),
        ...(policy.urlOptions ?? []),
        ...Object.keys(policy.forced ?? {}),
        ...(policy.unsupported ?? []),
        ...(policy.nameOptions ?? []),
        ...(policy.repeatable ?? []),
        ...(policy.caps?.count ?? []),
        ...(policy.caps?.duration ?? []),
        ...(policy.caps?.resolution ?? []),
        ...Object.keys(policy.uncappedOptions ?? {}),
      ];
      for (const name of named) expect(options.has(name), `${path} --${name}`).toBe(true);
      for (const name of policy.filePositionals ?? []) {
        expect(positionals.has(name), `${path} <${name}>`).toBe(true);
      }
      for (const name of policy.assetRefOptions ?? []) {
        expect(options.has(name) || positionals.has(name), `${path} ${name}`).toBe(true);
      }
    }
    for (const path of EXCLUDED_COMMANDS) expect(index.find(path), path).toBeDefined();
  });

  it("lists the offline `runway models` command with its --json flag", () => {
    const entry = new CatalogIndex().find("runway models");
    expect(entry?.group).toBe("runway");
    expect(entry?.command.options.map(optionName)).toContain("json");
  });

  it("maps provider groups to stored key names only", () => {
    const groups = new Set(CLI_CATALOG.groups.map((g) => g.group));
    for (const [group, names] of Object.entries(GROUP_KEYS)) {
      expect(groups.has(group), group).toBe(true);
      for (const name of names) expect(PROVIDER_SECRET_NAMES).toContain(name);
    }
  });

  it("covers every option that may name a local path or a file name", () => {
    // Any value option whose placeholder or description talks about files,
    // paths, directories or file names must be a file input, the server-owned
    // output, a checked file-name part, or unsupported. Exceptions are listed
    // by placeholder, with the reason.
    const fileish = /\b(?:file|files|path|paths|dir|directory|folder|filename|prefix|local)\b/i;
    const notPaths = new Set([
      "<json>", // inline JSON; a leading @ (read a file) is rejected for every value
      "<id>", // provider-side IDs (e.g. a HeyGen destination folder)
      "<str>", // plain text (e.g. align --text "... or pass --text-file")
      "<MB>", // a size
    ]);
    const missing: string[] = [];
    for (const group of CLI_CATALOG.groups) {
      for (const command of group.commands) {
        if (EXCLUDED_COMMANDS.has(command.command)) continue;
        const policy = policyFor(command.command);
        for (const option of command.options) {
          if (!option.takesValue) continue;
          if (!fileish.test(option.flags) && !fileish.test(option.description)) continue;
          const name = optionName(option);
          const placeholder = /<[^>]+>/.exec(option.flags)?.[0] ?? "";
          const covered =
            name === OUTPUT_FILE_OPTION ||
            name === OUTPUT_DIR_OPTION ||
            policy.fileOptions?.[name] !== undefined ||
            policy.nameOptions?.includes(name) ||
            policy.unsupported?.includes(name) ||
            notPaths.has(placeholder);
          if (!covered) missing.push(`${command.command} ${option.flags}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("treats every option the CLI documents as repeatable as repeatable", () => {
    const missing: string[] = [];
    for (const group of CLI_CATALOG.groups) {
      for (const command of group.commands) {
        const policy = policyFor(command.command);
        for (const option of command.options) {
          const documented = /\brepeatable\b(?!\s+output)|\brepeat --/i.test(option.description);
          if (
            documented &&
            !isRepeatable(option, policy) &&
            !policy.unsupported?.includes(optionName(option))
          ) {
            missing.push(`${command.command} ${option.flags}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("caps or marks uncapped every option that can raise spend", () => {
    // Counts, lengths, resolutions and raw request bodies change what a run
    // costs. Each such option of a runnable command must be capped
    // (MULTIX_MCP_MAX_OUTPUTS, MULTIX_MCP_MAX_VIDEO_SECONDS,
    // MULTIX_MCP_ALLOWED_RESOLUTIONS) or make the run uncapped
    // (MULTIX_MCP_UNCAPPED_SPEND). Options the name patterns match that do
    // not raise spend are listed with the reason.
    const kinds: [string, RegExp][] = [
      ["count", /^(?:n|num|count)$|^num-|-count$/],
      ["length", /duration|seconds|length|-ms$/],
      ["resolution", /resolution/],
    ];
    const rawBody = (flags: string, description: string) =>
      /<(?:json|raw)>/i.test(flags) ||
      /pass-?through|request body|input fields|raw flags/i.test(description);
    // Groups that run locally in the container and bill no provider.
    const localGroups = new Set(["media"]);
    const notSpend: Record<string, string> = {
      "elevenlabs transcribe num-speakers": "a hint for diarisation, not an output count",
      "fish tts chunk-length": "splits the text into requests; the text sets the price",
      "speech generate extra": "named per-provider settings (speed, stability…), not a raw body",
      "atlas image resolution": "an image resolution tier; image sizes are not capped (#447)",
      "atlas image-to-image resolution":
        "an image resolution tier; image sizes are not capped (#447)",
    };
    const missing: string[] = [];
    for (const group of CLI_CATALOG.groups) {
      if (localGroups.has(group.group)) continue;
      for (const command of group.commands) {
        if (EXCLUDED_COMMANDS.has(command.command)) continue;
        const policy = policyFor(command.command);
        if (policy.uncappedSpend) continue;
        const caps = policy.caps;
        for (const option of command.options) {
          if (!option.takesValue) continue;
          const name = optionName(option);
          const kind = kinds.find(([, pattern]) => pattern.test(name))?.[0];
          const raw =
            policy.fileOptions?.[name] === undefined && rawBody(option.flags, option.description);
          if (!kind && !raw) continue;
          const covered =
            policy.uncappedOptions?.[name] !== undefined ||
            policy.unsupported?.includes(name) ||
            (kind === "count" && caps?.count?.includes(name)) ||
            (kind === "length" && caps?.duration?.includes(name)) ||
            (kind === "resolution" && caps?.resolution?.includes(name)) ||
            notSpend[`${command.command} ${name}`] !== undefined;
          if (!covered) missing.push(`${command.command} --${name} (${kind ?? "raw body"})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("bounds or marks the resolution of every video-generating command", () => {
    // A video command with no resolution option still renders at some
    // resolution: the model's. Unless the command caps it, the run must be
    // marked uncapped (or the model that sets it listed with the reason).
    const fixedResolution: Record<string, string> = {
      "runway video": "--ratio is checked against each model's fixed list (at most 1920x1080)",
    };
    const missing: string[] = [];
    for (const group of CLI_CATALOG.groups) {
      for (const command of group.commands) {
        if (EXCLUDED_COMMANDS.has(command.command)) continue;
        if (!commandCapability(command.command)?.outputs.includes("video")) continue;
        const policy = policyFor(command.command);
        const bounded =
          policy.uncappedSpend !== undefined ||
          (policy.caps?.resolution?.length ?? 0) > 0 ||
          Object.values(policy.uncappedOptions ?? {}).some((why) => /resolution/.test(why)) ||
          fixedResolution[command.command] !== undefined;
        if (!bounded) missing.push(command.command);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("multix_catalog uncapped_spend marks", () => {
  type View = { command: string; uncapped_spend?: string; options: OptionView[] };
  type OptionView = { name: string; uncapped_spend?: string };
  const option = (group: string, command: string, name: string) => {
    const payload = catalogPayload({}, group) as { commands: View[] };
    const view = payload.commands.find((c) => c.command === command);
    return { command: view, option: view?.options.find((o) => o.name === name) };
  };

  it("marks options the model fills when omitted and options that make a run uncapped", () => {
    expect(option("atlas", "atlas video", "resolution").option?.uncapped_spend).toBe(
      "when omitted, the model picks the resolution",
    );
    expect(option("gemini", "gemini generate-video", "resolution").option).not.toHaveProperty(
      "uncapped_spend",
    );
    expect(option("byteplus", "byteplus video", "resolution").option).not.toHaveProperty(
      "uncapped_spend",
    );
    expect(option("fal", "fal video", "model").option?.uncapped_spend).toBe(
      "with this option, the model picks the video resolution",
    );
    expect(option("openrouter", "openrouter tts", "provider-options").option?.uncapped_spend).toBe(
      "with this option, the request reaches the provider as given",
    );
    expect(option("elevenlabs", "elevenlabs music", "prompt").command?.uncapped_spend).toBe(
      "billed by the track length, which no server cap bounds",
    );
  });
});
