/**
 * `multix scene` — multi-character dialogue for anime/film: voice profiles per
 * character, a scene manifest built from plain-text scripts, per-line
 * rendering with content-addressed caching (a changed line re-renders alone),
 * take variants and approval, and stem export for editors. Provider requests
 * go through the existing Gemini, OpenAI and ElevenLabs clients.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { run } from "../../agent/run-state.js";
import { ValidationError } from "../../core/errors.js";
import { createLogger } from "../../core/logger.js";
import {
  type SceneManifest,
  allLines,
  findLine,
  planScenes,
  readManifest,
  refreshStatus,
  requireManifest,
  sha256,
  summarize,
  writeManifest,
} from "./scene-manifest.js";
import { renderScenes, selectTargets } from "./scene-render.js";
import { SCENE_PROVIDERS, type SceneProvider } from "./speech-adapters.js";
import {
  type SettingValue,
  VOICE_PROFILE_SCHEMA,
  type VoiceProfile,
  assertValidProfile,
  loadProfiles,
  profilePath,
  writeProfile,
} from "./voice-profile.js";

const DEFAULT_FORMAT: Record<SceneProvider, string> = {
  gemini: "wav",
  openai: "mp3",
  elevenlabs: "mp3_44100_128",
};

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function parseSettings(values: string[]): Record<string, SettingValue> {
  const settings: Record<string, SettingValue> = {};
  for (const value of values) Object.assign(settings, parseSetting(value));
  return settings;
}

function parseSetting(value: string): Record<string, SettingValue> {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new ValidationError(`--setting must be key=value (got "${value}")`);
  const key = value.slice(0, eq).trim();
  const raw = value.slice(eq + 1).trim();
  const parsed: SettingValue =
    raw === "true"
      ? true
      : raw === "false"
        ? false
        : raw !== "" && !Number.isNaN(Number(raw))
          ? Number(raw)
          : raw;
  return { [key]: parsed };
}

function projectOf(opts: { project?: string }): string {
  return path.resolve(opts.project ?? ".");
}

/** JSON on stdout for --json (it becomes the envelope's `data`), prose otherwise. */
function emit(data: unknown, human: () => string): void {
  console.log(run.json ? JSON.stringify(data) : human());
}

/** Script paths are stored relative to the project so the folder can move. */
function relScript(projectDir: string, file: string): string {
  return path.relative(projectDir, path.resolve(file)).split(path.sep).join("/");
}

function replan(projectDir: string, previous: SceneManifest, scripts?: string[]) {
  const files = scripts ?? previous.scenes.map((s) => path.join(projectDir, s.script));
  const sources = files.map((file) => {
    if (!fs.existsSync(file)) throw new ValidationError(`Script not found: ${file}`);
    return { path: relScript(projectDir, file), source: fs.readFileSync(file, "utf8") };
  });
  return planScenes({
    scripts: sources,
    profiles: loadProfiles(projectDir),
    project: previous.project,
    previous,
  });
}

function registerVoiceCommands(scene: Command): void {
  const voice = scene.command("voice").description("Character voice profiles (voices/<id>.json)");

  voice
    .command("add <id>")
    .description("Create or update a character voice profile (no credentials are stored)")
    .requiredOption("--provider <name>", `Speech provider (${SCENE_PROVIDERS.join("|")})`)
    .requiredOption("--model <id>", "TTS model id")
    .requiredOption("--voice <id>", "Provider voice id or name")
    .option("--format <fmt>", "Output format (default: wav | mp3 | mp3_44100_128 by provider)")
    .option("--language <tag>", "BCP 47 language, e.g. vi or vi-VN")
    .option("--name <str>", "Display name")
    .option("--alias <name>", "Script speaker name for this voice (repeatable)", collect, [])
    .option("--style <text>", "Delivery direction for every line (models that take one)")
    .option(
      "--setting <key=value>",
      "Provider setting, e.g. stability=0.4 (repeatable)",
      collect,
      [],
    )
    .option("--context", "Send neighbouring lines as previous/next text (ElevenLabs v2 models)")
    .option("--max-chars <n>", "Split lines longer than this")
    .option("--cloned", "The voice is a cloud clone of a real person's voice")
    .option(
      "--consent-by <name>",
      "Who granted consent to clone the voice (required with --cloned)",
    )
    .option("--consent-at <iso>", "When consent was granted (default: now)")
    .option("--consent-note <text>", "Scope or reference of the consent")
    .option("--force", "Replace an existing profile (its version is bumped)")
    .option("--project <dir>", "Scene project directory", ".")
    .action((id: string, opts) => {
      const projectDir = projectOf(opts);
      const provider = opts.provider as SceneProvider;
      const settings = parseSettings(opts.setting);
      const file = profilePath(projectDir, id);
      let version = 1;
      if (fs.existsSync(file)) {
        if (!opts.force) throw new ValidationError(`${file} exists; pass --force to replace it`);
        const old = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VoiceProfile>;
        version = (Number.isInteger(old.version) ? (old.version as number) : 0) + 1;
      }
      if (opts.cloned && !opts.consentBy) {
        throw new ValidationError(
          "--cloned needs --consent-by <name>: record who agreed to the clone",
        );
      }
      const profile = {
        schema: VOICE_PROFILE_SCHEMA,
        id,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.alias.length ? { aliases: opts.alias } : {}),
        version,
        provider,
        model: opts.model,
        voice: opts.voice,
        ...(opts.language ? { language: opts.language } : {}),
        format: opts.format ?? DEFAULT_FORMAT[provider] ?? "",
        ...(opts.style ? { style: opts.style } : {}),
        ...(Object.keys(settings).length ? { settings } : {}),
        ...(opts.context ? { context: true } : {}),
        ...(opts.maxChars ? { max_chars: Number(opts.maxChars) } : {}),
        ...(opts.cloned
          ? {
              clone: {
                consent: {
                  granted_by: opts.consentBy,
                  granted_at: opts.consentAt ?? new Date().toISOString(),
                  ...(opts.consentNote ? { note: opts.consentNote } : {}),
                },
              },
            }
          : {}),
      };
      const valid = assertValidProfile(profile, id);
      if (opts.dryRun) {
        emit(
          { profile: valid, path: file, written: false },
          () => `Valid profile (not written): ${file}`,
        );
        return;
      }
      writeProfile(projectDir, valid);
      emit(
        { profile: valid, path: file, written: true },
        () => `Saved voice profile: ${file} (v${version})`,
      );
    });

  voice
    .command("list")
    .description("List voice profiles")
    .option("--project <dir>", "Scene project directory", ".")
    .action((opts) => {
      const profiles = [...loadProfiles(projectOf(opts)).values()];
      emit({ voices: profiles }, () =>
        profiles.length
          ? profiles
              .map(
                (p) =>
                  `${p.id}  v${p.version}  ${p.provider}/${p.model}  voice=${p.voice}${p.language ? `  ${p.language}` : ""}`,
              )
              .join("\n")
          : "No voice profiles yet (multix scene voice add <id> ...)",
      );
    });

  voice
    .command("validate")
    .description("Validate every voice profile without calling a provider")
    .option("--project <dir>", "Scene project directory", ".")
    .action((opts) => {
      const profiles = loadProfiles(projectOf(opts));
      emit(
        { valid: true, voices: [...profiles.keys()] },
        () => `${profiles.size} voice profile(s) valid`,
      );
    });
}

export function registerSceneCommands(program: Command): void {
  const scene = program
    .command("scene")
    .description(
      "Multi-character dialogue: voice profiles, scene manifests, per-line takes, approval and stem export",
    );

  registerVoiceCommands(scene);

  scene
    .command("plan [scripts...]")
    .description(
      "Parse scene scripts (all of them; none = the ones already planned) into the manifest; keeps takes whose request is unchanged (local, no cost)",
    )
    .option("--project <dir>", "Scene project directory", ".")
    .option("--name <str>", "Project name (default: directory name)")
    .action((scripts: string[], opts) => {
      const projectDir = projectOf(opts);
      const previous = readManifest(projectDir);
      const base: SceneManifest = previous ?? {
        schema: "multix.scene/v1",
        project: opts.name ?? path.basename(projectDir),
        updated_at: "",
        voices: {},
        scenes: [],
      };
      if (opts.name) base.project = opts.name;
      if (scripts.length === 0 && !previous) {
        throw new ValidationError("Pass the scene script files: multix scene plan s01.txt s02.txt");
      }
      const plan = replan(
        projectDir,
        base,
        scripts.length ? scripts.map((s) => path.resolve(s)) : undefined,
      );
      const { targets, cached } = selectTargets(plan.manifest, {});
      const data = {
        project: plan.manifest.project,
        manifest: path.join(projectDir, "multix-scene.json"),
        written: !opts.dryRun,
        scenes: plan.manifest.scenes.length,
        lines: allLines(plan.manifest).length,
        to_render: targets.map((l) => l.id),
        to_render_chars: targets.reduce((n, l) => n + l.chars, 0),
        cached,
        invalidated: plan.invalidated,
        added: plan.added,
        removed: plan.removed,
        // No price table yet: unknown is reported as null, never as zero.
        estimated_cost_usd: null,
      };
      if (!opts.dryRun) writeManifest(projectDir, plan.manifest);
      emit(data, () =>
        [
          `${data.scenes} scene(s), ${data.lines} line(s): ${targets.length} to render (${data.to_render_chars} chars), ${cached} cached`,
          ...(plan.invalidated.length
            ? [`Changed since last render: ${plan.invalidated.join(", ")}`]
            : []),
          data.written ? `Manifest: ${data.manifest}` : "Dry run: manifest not written",
          ...(targets.length ? [`Next: multix scene render --project ${projectDir}`] : []),
        ].join("\n"),
      );
    });

  scene
    .command("render")
    .description(
      "Render lines without a take for their current request (one request per line, no retries)",
    )
    .option("--project <dir>", "Scene project directory", ".")
    .option("--scene <id>", "Only this scene")
    .option("--line <id>", "Only this line, e.g. s01/003 (repeatable)", collect, [])
    .option("--new-take", "Render a new variant of the --line lines even if cached")
    .option("--limit <n>", "Send at most this many requests")
    .option("--keep-going", "Continue with other lines after a failed line")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      // Progress goes to stderr so stdout stays the result (JSON with --json).
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const projectDir = projectOf(opts);
      const plan = replan(projectDir, requireManifest(projectDir));
      const manifest = plan.manifest;
      if (plan.invalidated.length)
        logger.info(`Script or voice changed: ${plan.invalidated.join(", ")}`);
      const limit = opts.limit !== undefined ? Number(opts.limit) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
        throw new ValidationError("--limit must be a positive integer");
      }
      // A dry run stops at the first request; nothing is written before it.
      if (!opts.dryRun) writeManifest(projectDir, manifest);
      const result = await renderScenes({
        projectDir,
        manifest,
        profiles: loadProfiles(projectDir),
        scene: opts.scene,
        lines: opts.line,
        newTake: opts.newTake,
        limit,
        keepGoing: opts.keepGoing,
        logger,
      });
      const scenes = summarize(manifest);
      emit({ ...result, scenes }, () =>
        [
          `Rendered ${result.rendered.length} line(s), ${result.cached} cached, ${result.failed.length} failed`,
          ...result.failed.map((f) => `  ✗ ${f.line}: ${f.code} ${f.message}`),
          ...(result.remaining.length
            ? [`Not rendered yet: ${result.remaining.length} line(s)`]
            : []),
          ...scenes.map(
            (s) => `  ${s.scene}: ${s.rendered}/${s.lines} rendered, ${s.approved} approved`,
          ),
        ].join("\n"),
      );
      if (result.failed.length) process.exitCode = 1;
    });

  scene
    .command("approve <lines...>")
    .description("Approve the selected take (or --take) of each line")
    .option("--take <id>", "Take to select and approve (one line only)")
    .option("--project <dir>", "Scene project directory", ".")
    .action((lines: string[], opts) => {
      const projectDir = projectOf(opts);
      const manifest = requireManifest(projectDir);
      if (opts.take && lines.length > 1) throw new ValidationError("--take applies to one line");
      for (const id of lines) {
        const line = findLine(manifest, id);
        const takeId = opts.take ?? line.selected_take;
        const take = line.takes.find((t) => t.id === takeId);
        if (!take)
          throw new ValidationError(`Line ${id} has no take "${takeId ?? ""}" (render it first)`);
        if (take.cache_key !== line.cache_key) {
          throw new ValidationError(
            `Take ${take.id} of ${id} was rendered for an older script or voice`,
          );
        }
        for (const t of line.takes)
          if (t.status === "approved" && t.id !== take.id) t.status = "candidate";
        take.status = "approved";
        line.selected_take = take.id;
        refreshStatus(line);
      }
      if (!opts.dryRun) writeManifest(projectDir, manifest);
      emit({ approved: lines, written: !opts.dryRun }, () => `Approved: ${lines.join(", ")}`);
    });

  scene
    .command("reject <line>")
    .description("Reject a take; the line falls back to its newest other take for the same request")
    .requiredOption("--take <id>", "Take to reject")
    .option("--project <dir>", "Scene project directory", ".")
    .action((id: string, opts) => {
      const projectDir = projectOf(opts);
      const manifest = requireManifest(projectDir);
      const line = findLine(manifest, id);
      const take = line.takes.find((t) => t.id === opts.take);
      if (!take) throw new ValidationError(`Line ${id} has no take "${opts.take}"`);
      take.status = "rejected";
      if (line.selected_take === take.id) {
        const fallback = [...line.takes]
          .reverse()
          .find((t) => t.cache_key === line.cache_key && t.status !== "rejected");
        line.selected_take = fallback?.id;
      }
      refreshStatus(line);
      if (!opts.dryRun) writeManifest(projectDir, manifest);
      emit(
        { rejected: take.id, line: id, status: line.status },
        () => `Rejected ${take.id}; ${id} is ${line.status}`,
      );
    });

  scene
    .command("status")
    .description("Completion, takes, duration and reported spend per scene")
    .option("--project <dir>", "Scene project directory", ".")
    .option("--lines", "Include per-line status (ids, speakers, takes; no script text)")
    .action((opts) => {
      const manifest = requireManifest(projectOf(opts));
      const scenes = summarize(manifest);
      const lines = opts.lines
        ? allLines(manifest).map((l) => ({
            id: l.id,
            speaker: l.speaker,
            status: l.status,
            chars: l.chars,
            selected_take: l.selected_take ?? null,
            takes: l.takes.length,
            ...(l.error ? { error: l.error.code } : {}),
          }))
        : undefined;
      emit({ project: manifest.project, scenes, ...(lines ? { lines } : {}) }, () =>
        [
          `Project ${manifest.project}`,
          ...scenes.map(
            (s) =>
              `  ${s.scene}: ${s.rendered}/${s.lines} rendered, ${s.approved} approved, ${s.failed} failed, ` +
              `${s.duration_s}s, cost ${s.cost_usd === null ? "unknown" : `$${s.cost_usd}`}` +
              `${s.credits !== null ? `, ${s.credits} credits` : ""}${s.complete ? " ✓" : ""}`,
          ),
          ...(lines ?? []).map(
            (l) => `  ${l.id}  ${l.speaker}  ${l.status}  ${l.selected_take ?? "-"}`,
          ),
        ].join("\n"),
      );
    });

  scene
    .command("export")
    .description("Copy the selected take of every line as audio stems plus an export manifest")
    .requiredOption("--out <dir>", "Export directory")
    .option("--approved-only", "Export approved takes only; other lines count as missing")
    .option("--allow-missing", "Export even when some lines have no usable take")
    .option("--scene <id>", "Only this scene")
    .option("--project <dir>", "Scene project directory", ".")
    .action((opts) => {
      const projectDir = projectOf(opts);
      const manifest = requireManifest(projectDir);
      const outDir = path.resolve(opts.out);
      const missing: string[] = [];
      const scenes = manifest.scenes
        .filter((s) => !opts.scene || s.id === opts.scene)
        .map((s) => ({
          id: s.id,
          ...(s.title ? { title: s.title } : {}),
          stems: s.lines.flatMap((line) => {
            const take = line.takes.find((t) => t.id === line.selected_take);
            const usable =
              take &&
              take.cache_key === line.cache_key &&
              (!opts.approvedOnly || take.status === "approved");
            if (!usable) {
              missing.push(line.id);
              return [];
            }
            const src = path.join(projectDir, take.path);
            if (!fs.existsSync(src) || sha256(fs.readFileSync(src)) !== take.sha256) {
              throw new ValidationError(`Take file for ${line.id} is missing or changed: ${src}`);
            }
            const rest = line.id.split("/")[1] ?? line.id;
            const file = `${s.id}/${rest}_${line.speaker}${path.extname(take.path)}`;
            return [
              {
                line: line.id,
                speaker: line.speaker,
                speaker_label: line.speaker_label,
                text: line.text,
                ...(line.direction ? { direction: line.direction } : {}),
                file,
                take: take.id,
                approved: take.status === "approved",
                sha256: take.sha256,
                bytes: take.bytes,
                ...(take.duration_s !== undefined ? { duration_s: take.duration_s } : {}),
                ...(take.sample_rate ? { sample_rate: take.sample_rate } : {}),
                provider: line.request.provider,
                model: line.request.model,
                _src: src,
              },
            ];
          }),
        }));
      if (opts.scene && scenes.length === 0) throw new ValidationError(`No scene "${opts.scene}"`);
      if (missing.length && !opts.allowMissing) {
        throw new ValidationError(
          `${missing.length} line(s) have no ${opts.approvedOnly ? "approved " : ""}take: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""} (render/approve them or pass --allow-missing)`,
        );
      }
      const exported = {
        schema: "multix.scene-export/v1",
        project: manifest.project,
        exported_at: new Date().toISOString(),
        missing,
        scenes: scenes.map((s) => ({ ...s, stems: s.stems.map(({ _src, ...rest }) => rest) })),
      };
      if (!opts.dryRun) {
        for (const s of scenes) {
          for (const stem of s.stems) {
            const dest = path.join(outDir, stem.file);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(stem._src, dest);
          }
        }
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
          path.join(outDir, "scene-export.json"),
          `${JSON.stringify(exported, null, 2)}\n`,
        );
      }
      const count = scenes.reduce((n, s) => n + s.stems.length, 0);
      emit(
        { out: outDir, stems: count, missing, written: !opts.dryRun },
        () =>
          `Exported ${count} stem(s) to ${outDir}${missing.length ? ` (${missing.length} missing)` : ""}`,
      );
    });
}
