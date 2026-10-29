import { describe, expect, it } from "vitest";
import { catalogPayload } from "../src/jobs/catalog-view.js";
import type { CliCommand, CliOption } from "../src/jobs/cli-catalog-types.js";
import { CLI_CATALOG, optionName } from "../src/jobs/cli-catalog.js";
import {
  type CommandPolicy,
  EXCLUDED_COMMANDS,
  GROUP_KEYS,
  policyFor,
} from "../src/jobs/cli-command-policy.js";

type SpendKind = "count" | "duration" | "resolution" | "raw";

/**
 * Options that look able to raise spend but do not, or whose spend is bounded
 * another way. Key: `<command> --<option>`. Every entry must still match an
 * option the walk finds; a stale one fails the test.
 */
const NOT_SPEND: Readonly<Record<string, string>> = {
  "elevenlabs transcribe --num-speakers": "a diarization hint; billing is by audio length",
  "elevenlabs dub --num-speakers": "a diarization hint; the command is uncapped anyway",
  "elevenlabs sfx --duration-seconds": "ElevenLabs bounds a sound effect at 30 s",
  "fish tts --chunk-length": "a text chunking size; billing is by the bytes of the text",
  "atlas image --resolution": "an image tier (1k, 2k); --num-images bounds the number of images",
  "atlas image-to-image --resolution":
    "an image tier (1k, 2k); --num-images bounds the number of images",
  "speech generate --extra":
    "keys come from a fixed list per provider (speed, stability, seed, …), none of which changes the billed unit",
};

/** What an option can raise, judged from its name; undefined when nothing. */
function spendKind(option: CliOption, policy: CommandPolicy): SpendKind | undefined {
  if (!option.takesValue) return undefined;
  const name = optionName(option);
  if (/^(n|num|count)$|^num-|-count$/.test(name)) return "count";
  if (/duration|seconds|length/.test(name)) return "duration";
  if (/resolution/.test(name)) return "resolution";
  // A downloaded media file is not a request body.
  if (policy.fileOptions?.[name] && name !== "plan") return undefined;
  if (/^(input|extra|flags|body|params|plan|options)$|-options$/.test(name)) return "raw";
  return undefined;
}

function isCovered(name: string, kind: SpendKind, policy: CommandPolicy): boolean {
  if (policy.uncappedSpend) return true;
  if (policy.uncappedOptions?.includes(name)) return true;
  if (policy.unsupported?.includes(name) || policy.forced?.[name] !== undefined) return true;
  if (kind === "raw") return false;
  return policy.caps?.[kind]?.includes(name) ?? false;
}

/** Commands a remote caller can run that spend on a provider (their group gets provider keys). */
function spendingCommands(): CliCommand[] {
  return CLI_CATALOG.groups
    .filter((group) => (GROUP_KEYS[group.group]?.length ?? 0) > 0)
    .flatMap((group) => group.commands)
    .filter((command) => !EXCLUDED_COMMANDS.has(command.command));
}

describe("spend caps cover every catalog command", () => {
  it("caps or marks uncapped every option that can raise spend", () => {
    const uncovered: string[] = [];
    const exempted = new Set<string>();
    for (const command of spendingCommands()) {
      const policy = policyFor(command.command);
      for (const option of command.options) {
        const kind = spendKind(option, policy);
        if (!kind) continue;
        const name = optionName(option);
        const key = `${command.command} --${name}`;
        if (NOT_SPEND[key]) exempted.add(key);
        else if (!isCovered(name, kind, policy)) uncovered.push(`${key} (${kind})`);
      }
    }
    expect(uncovered, "cap these in cli-command-policy.ts or mark them uncapped").toEqual([]);
    expect(Object.keys(NOT_SPEND).filter((key) => !exempted.has(key))).toEqual([]);
  });

  it("does not leave an omitted capped resolution to the model", () => {
    const leftToModel: string[] = [];
    for (const command of spendingCommands()) {
      const policy = policyFor(command.command);
      const caps = policy.caps;
      if (policy.uncappedSpend || caps?.fillResolution || caps?.resolutionFromModel) continue;
      for (const name of caps?.resolution ?? []) {
        const option = command.options.find((o) => optionName(o) === name);
        if (option?.default === undefined) leftToModel.push(`${command.command} --${name}`);
      }
    }
    expect(leftToModel, "set fillResolution or resolutionFromModel").toEqual([]);
  });

  it("flags an unclassified spend option on a new command", () => {
    const option: CliOption = {
      long: "--num-videos",
      flags: "--num-videos <n>",
      description: "How many videos",
      required: false,
      takesValue: true,
      valueOptional: false,
      variadic: false,
      negatable: false,
    };
    expect(spendKind(option, {})).toBe("count");
    expect(isCovered("num-videos", "count", {})).toBe(false);
    expect(isCovered("num-videos", "count", { caps: { count: ["num-videos"] } })).toBe(true);
    const body = { ...option, long: "--options", flags: "--options <json>", description: "x" };
    expect(spendKind(body, {})).toBe("raw");
    expect(isCovered("options", "raw", { uncappedOptions: ["options"] })).toBe(true);
  });

  it("shows the new uncapped cases in multix_catalog", () => {
    // biome-ignore lint/suspicious/noExplicitAny: JSON payloads are untyped in tests
    const commands = (group: string): any[] => catalogPayload({}, group).commands as any[];
    const atlasVideo = commands("atlas").find((c) => c.command === "atlas video");
    expect(atlasVideo.options.find((o: { name: string }) => o.name === "resolution")).toMatchObject(
      { uncapped_spend: "when omitted, the model picks the resolution" },
    );
    const falVideo = commands("fal").find((c) => c.command === "fal video");
    expect(falVideo.uncapped_spend).toBe(
      "the model picks the resolution (fal video has no --resolution)",
    );
    const tts = commands("openrouter").find((c) => c.command === "openrouter tts");
    expect(tts.options.find((o: { name: string }) => o.name === "provider-options")).toMatchObject({
      uncapped_spend: "with this option, the server caps do not bound the request",
    });
  });
});
