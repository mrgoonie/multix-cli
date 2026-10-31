/**
 * The capability registry states what each command and verified model does.
 * These checks keep it truthful: every CLI command is classified, generic
 * runners are not mistaken for a task, verified models agree with their own
 * input schema, and catalog-only models are never reported as verified.
 */

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { TASKS, isTask } from "../../../src/capabilities/capability-types.js";
import {
  COMMAND_CAPABILITIES,
  UTILITY_COMMANDS,
} from "../../../src/capabilities/command-capabilities.js";
import {
  MODEL_CAPABILITIES,
  checkModelInput,
  findModelCapability,
  verifiedModels,
} from "../../../src/capabilities/model-registry.js";
import {
  type CatalogResult,
  catalogCommand,
  genericRunner,
  mergeModelViews,
} from "../../../src/capabilities/model-views.js";
import { modelRows } from "../../../src/commands/agent/models-command.js";
import { registerCommands } from "../../../src/commands/index.js";
import { FAL_SPEECH_MODELS, findSpeechModel } from "../../../src/providers/fal/speech-models.js";

function buildProgram(): Command {
  const program = new Command().name("multix").enablePositionalOptions();
  registerCommands(program);
  return program;
}

function leafCommands(cmd: Command, prefix: string[] = []): string[] {
  if (cmd.commands.length === 0) return [prefix.join(" ")];
  return cmd.commands.flatMap((sub) => leafCommands(sub, [...prefix, sub.name()]));
}

const program = buildProgram();
const leaves = new Set(leafCommands(program));

describe("command capabilities", () => {
  it("classifies every CLI command as task-serving or utility, never both", () => {
    const unclassified = [...leaves].filter(
      (c) => !(c in COMMAND_CAPABILITIES) && !UTILITY_COMMANDS.has(c),
    );
    expect(unclassified).toEqual([]);
    const both = [...UTILITY_COMMANDS].filter((c) => c in COMMAND_CAPABILITIES);
    expect(both).toEqual([]);
  });

  it("names only commands the CLI has", () => {
    const named = [...Object.keys(COMMAND_CAPABILITIES), ...UTILITY_COMMANDS];
    expect(named.filter((c) => !leaves.has(c))).toEqual([]);
  });

  it("uses known tasks, and a scope only for commands that pass any model id", () => {
    for (const [command, cap] of Object.entries(COMMAND_CAPABILITIES)) {
      expect(cap.tasks.length, command).toBeGreaterThan(0);
      expect(cap.tasks.every(isTask), command).toBe(true);
      expect(cap.scope !== undefined, command).toBe(cap.models === "provider-catalog");
    }
  });

  it("lists scene render for speech, ready only with a key of a scene provider", () => {
    const sceneRows = () => modelRows(program).filter((r) => r.provider === "scene");
    try {
      for (const key of ["GEMINI_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY"]) {
        vi.stubEnv(key, "");
      }
      expect(sceneRows()).toMatchObject([
        { task: "speech", command: "scene render", outputs: ["audio"], ready: false },
      ]);
      vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
      expect(sceneRows()[0]?.ready).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not label fal run as speech (or any task) by itself", () => {
    expect(COMMAND_CAPABILITIES["fal run"]).toMatchObject({
      tasks: ["any"],
      models: "provider-catalog",
    });
    const falRun = modelRows(program).filter((r) => r.command === "fal run");
    expect(falRun.map((r) => r.task).sort()).toEqual(["any", "speech"]);
    const speech = falRun.find((r) => r.task === "speech");
    // Speech through fal run is only the verified ids routed to it, not "any model".
    expect(speech?.any_model).toBeUndefined();
    expect(speech?.verified_models).toEqual(
      verifiedModels({ task: "speech", provider: "fal" })
        .filter((m) => m.command === "fal run")
        .map((m) => m.model),
    );
    expect(speech?.models).toEqual(speech?.verified_models);
    expect(speech?.example).toMatch(/^multix fal run /);
  });

  it("lists the typed fal tts models as verified on its row", () => {
    const tts = modelRows(program).find((r) => r.command === "fal tts");
    expect(tts).toMatchObject({ task: "speech", any_model: true, outputs: ["audio"] });
    expect(tts?.verified_models?.sort()).toEqual(FAL_SPEECH_MODELS.map((m) => m.id).sort());
    for (const id of tts?.verified_models ?? []) {
      expect(findModelCapability(id)?.command).toBe("fal tts");
    }
  });

  it("does not advertise arbitrary OpenRouter modalities", () => {
    const tasks = new Set(
      modelRows(program)
        .filter((r) => r.provider === "openrouter")
        .map((r) => r.task),
    );
    expect([...tasks].sort()).toEqual([
      "image",
      "image-edit",
      "image-to-video",
      "speech",
      "transcription",
    ]);
  });

  it("reports outputs and model scope on rows, keeping the old row fields", () => {
    const rows = modelRows(program);
    const tts = rows.find((r) => r.command === "gemini generate-speech");
    expect(tts).toMatchObject({ task: "speech", provider: "gemini", outputs: ["audio"] });
    expect(typeof tts?.ready).toBe("boolean");
    const orImage = rows.find((r) => r.command === "openrouter generate");
    expect(orImage).toMatchObject({ any_model: true, model_scope: expect.any(String) });
    for (const row of rows) expect(isTask(row.task), row.command).toBe(true);
  });

  it("finds the command that takes any catalog id for a task, and the generic runner", () => {
    expect(catalogCommand("openrouter", "image")).toBe("openrouter generate");
    expect(catalogCommand("openrouter", "speech")).toBe("openrouter tts");
    expect(catalogCommand("openrouter", "transcription")).toBe("openrouter transcribe");
    expect(catalogCommand("openrouter", "video-edit")).toBeNull();
    expect(catalogCommand("fal", "speech")).toBe("fal tts");
    expect(catalogCommand("fal", "transcription")).toBeNull();
    expect(genericRunner("fal")).toBe("fal run");
    expect(genericRunner("openrouter")).toBeUndefined();
  });
});

describe("verified model registry", () => {
  it("lists each model once, on a command that exists, for known tasks", () => {
    const ids = MODEL_CAPABILITIES.map((m) => `${m.provider}/${m.model}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MODEL_CAPABILITIES) {
      expect(leaves.has(m.command), m.model).toBe(true);
      expect(m.command.split(" ")[0], m.model).toBe(m.provider);
      expect(
        m.tasks.every((t) => (TASKS as readonly string[]).includes(t)),
        m.model,
      ).toBe(true);
      expect(m.source.url, m.model).toMatch(/^https:\/\//);
      expect(m.source.verified_at, m.model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.example, m.model).toContain(m.model);
    }
  });

  it("keeps required fields, required_any groups and defaults consistent with inputs", () => {
    for (const m of MODEL_CAPABILITIES) {
      for (const group of m.required_any ?? []) {
        for (const field of group) expect(m.inputs[field], `${m.model} ${field}`).toBeDefined();
      }
      for (const [field, spec] of Object.entries(m.inputs)) {
        if (spec.values && spec.default !== undefined) {
          expect(spec.values, `${m.model} ${field}`).toContain(spec.default);
        }
      }
      // fal tts maps typed flags onto the models it lists; --input examples pass their own check.
      if (m.command === "fal tts") {
        expect(findSpeechModel(m.model), m.model).toBeDefined();
        continue;
      }
      // Typed-flag commands (gemini generate-music, music-live) have no --input example.
      if (m.command !== "fal run") continue;
      const json = m.example.match(/--input '(.+)'$/)?.[1];
      expect(json, m.model).toBeDefined();
      expect(checkModelInput(m, JSON.parse(json ?? "{}")), m.model).toEqual({
        unsupported: [],
        missing: [],
        invalid: [],
      });
    }
  });

  it("filters by task and provider and finds a model by id", () => {
    expect(verifiedModels({ task: "speech" }).length).toBe(
      MODEL_CAPABILITIES.filter((m) => m.tasks.includes("speech")).length,
    );
    expect(verifiedModels({ task: "music", provider: "gemini" }).map((m) => m.model)).toEqual([
      "lyria-3-clip-preview",
      "lyria-3.5",
      "lyria-realtime-exp",
    ]);
    expect(verifiedModels({ task: "image" })).toEqual([]);
    expect(verifiedModels({ provider: "openrouter" })).toEqual([]);
    expect(findModelCapability("elevenlabs/tts/eleven-v4")?.provider).toBe("fal");
    expect(findModelCapability("elevenlabs/tts/eleven-v4", "openrouter")).toBeUndefined();
    expect(findModelCapability("someone/unknown-model")).toBeUndefined();
  });

  it("reports unsupported options, missing fields and values outside the list", () => {
    const eleven = findModelCapability("elevenlabs/tts/eleven-v4");
    const gemini = findModelCapability("google/gemini-3.8-flash-tts");
    if (!eleven || !gemini) throw new Error("registry entries missing");
    expect(checkModelInput(eleven, { prompt: "hi", output_format: "wav" })).toEqual({
      unsupported: ["prompt"],
      missing: ["text"],
      invalid: [{ field: "output_format", value: "wav", allowed: expect.any(Array) }],
    });
    expect(checkModelInput(gemini, { voice: "Kore" }).missing).toEqual([
      "prompt or speakers+turns",
    ]);
    expect(checkModelInput(gemini, { speakers: [], turns: [] }).missing).toEqual([]);
    expect(checkModelInput(gemini, { prompt: "x", voice: "Nobody" }).invalid).toHaveLength(1);
  });
});

describe("merged model views", () => {
  const source = (provider: string, state: CatalogResult["source"]["state"]) => ({
    provider,
    task: "speech" as const,
    state,
  });
  const verifiedFal = verifiedModels({ task: "speech", provider: "fal" }).map((m) => m.model);

  it("marks verified models the catalog still lists, and flags removed or renamed ones", () => {
    const [kept, ...dropped] = verifiedFal;
    const views = mergeModelViews("speech", [
      {
        source: source("fal", "fresh"),
        models: [
          { provider: "fal", model: kept ?? "", task: "speech" },
          { provider: "fal", model: "new-vendor/tts", task: "speech", name: "New TTS" },
        ],
      },
    ]);
    const byId = Object.fromEntries(views.map((v) => [v.model, v]));
    expect(byId[kept ?? ""]).toMatchObject({
      verified: true,
      listed: true,
      command: findModelCapability(kept ?? "")?.command,
    });
    expect(byId[kept ?? ""]?.status).toBeUndefined();
    for (const id of dropped) {
      expect(byId[id]).toMatchObject({ verified: true, listed: false, status: "missing" });
      expect(byId[id]?.note).toMatch(/removed or renamed/);
    }
    // Catalog-only: never verified; fal tts takes any fal TTS id (with --text-field).
    expect(byId["new-vendor/tts"]).toMatchObject({
      verified: false,
      command: "fal tts",
      listed: true,
    });
    expect(byId["new-vendor/tts"]?.note).toMatch(/^unverified/);
  });

  it("offers only the generic runner when no command serves the task", () => {
    const views = mergeModelViews("transcription", [
      {
        source: { provider: "fal", task: "transcription", state: "fresh" },
        models: [{ provider: "fal", model: "vendor/stt", task: "transcription" }],
      },
    ]);
    expect(views).toEqual([
      expect.objectContaining({ verified: false, command: null, runner: "fal run" }),
    ]);
  });

  it("does not call a verified model missing from a truncated catalog", () => {
    const views = mergeModelViews("speech", [
      { source: { ...source("fal", "fresh"), truncated: true }, models: [] },
    ]);
    expect(views.length).toBe(verifiedFal.length);
    expect(views.every((v) => v.listed === null && v.status === undefined)).toBe(true);
  });

  it("leaves verified models unknown when the catalog could not be read", () => {
    const views = mergeModelViews("speech", [{ source: source("fal", "unavailable"), models: [] }]);
    expect(views.map((v) => v.model)).toEqual(verifiedFal);
    expect(views.every((v) => v.listed === null && v.status === undefined)).toBe(true);
  });

  it("does not point catalog models at a command that cannot run them", () => {
    const views = mergeModelViews("video-edit", [
      {
        source: { ...source("openrouter", "fresh"), task: "video-edit" },
        models: [
          {
            provider: "openrouter",
            model: "vendor/video-edit-1",
            task: "video-edit",
            voices: ["a", "b"],
            pricing: { prompt: "0.1" },
          },
        ],
      },
    ]);
    const or = views.find((v) => v.model === "vendor/video-edit-1");
    expect(or).toMatchObject({ verified: false, command: null, voices: 2 });
    expect(or?.runner).toBeUndefined();
    expect(or?.note).toMatch(/no multix command/);
  });

  it("points catalog models at a command that passes any id for the task", () => {
    const views = mergeModelViews("image", [
      {
        source: { provider: "openrouter", task: "image", state: "cached" },
        models: [{ provider: "openrouter", model: "vendor/image-1", task: "image" }],
      },
    ]);
    expect(views).toEqual([
      expect.objectContaining({ verified: false, command: "openrouter generate", listed: true }),
    ]);
  });
});
