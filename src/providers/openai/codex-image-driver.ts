import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, ProviderError } from "../../core/errors.js";
import { getOutputDir } from "../../core/output-dir.js";
import {
  type OpenAIImageDriver,
  type OpenAIImageOutputFormat,
  extFromImageFormat,
} from "./models.js";

export type ProcessRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultRunner: ProcessRunner = async (cmd, args, opts) => {
  const res = await execa(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env,
    reject: false,
    timeout: opts?.timeoutMs,
  });
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode ?? 0 };
};

export async function checkCodexAuthenticated(
  runner: ProcessRunner = defaultRunner,
): Promise<boolean> {
  try {
    const res = await runner("codex", ["login", "status"], { timeoutMs: 15_000 });
    return res.exitCode === 0 && /Logged in using ChatGPT/i.test(`${res.stdout}\n${res.stderr}`);
  } catch {
    return false;
  }
}

export async function resolveImageDriver(opts: {
  requested: OpenAIImageDriver;
  hasApiKey?: boolean;
  codexAuthCheck?: () => Promise<boolean>;
}): Promise<"api" | "codex"> {
  const hasApiKey = opts.hasApiKey ?? Boolean(resolveKey("OPENAI_API_KEY"));
  const codexAuthCheck = opts.codexAuthCheck ?? (() => checkCodexAuthenticated());
  if (opts.requested === "api") {
    if (!hasApiKey) throw new ConfigError("OPENAI_API_KEY is required for --driver api");
    return "api";
  }
  if (opts.requested === "codex") {
    if (!(await codexAuthCheck())) throw new ConfigError("Codex driver requires `codex login`");
    return "codex";
  }
  if (hasApiKey) return "api";
  if (await codexAuthCheck()) return "codex";
  throw new ConfigError(
    "Set OPENAI_API_KEY or run `codex login` for the experimental image driver",
  );
}

export function sanitizeCodexEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "TEMP", "LANG", "LC_ALL"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export async function runCodexImageGeneration(opts: {
  prompt: string;
  refs?: string[];
  outputFormat: OpenAIImageOutputFormat;
  output?: string;
  runner?: ProcessRunner;
}): Promise<{ path: string }> {
  const runner = opts.runner ?? defaultRunner;
  const ext = extFromImageFormat(opts.outputFormat);
  const dest = opts.output
    ? path.resolve(opts.output)
    : path.join(getOutputDir(), `codex-image-${Date.now()}.${ext}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-codex-image-"));
  const schema = path.join(tmp, "schema.json");
  const result = path.join(tmp, "result.json");
  fs.writeFileSync(
    schema,
    JSON.stringify({
      type: "object",
      properties: { status: { type: "string" }, path: { type: "string" } },
      required: ["status", "path"],
      additionalProperties: false,
    }),
  );

  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--cd",
    tmp,
    "--output-schema",
    schema,
    "--output-last-message",
    result,
  ];
  for (const ref of opts.refs ?? []) args.push("--image", ref);
  args.push(buildCodexPrompt(opts.prompt, dest));

  const res = await runner("codex", args, {
    cwd: tmp,
    env: sanitizeCodexEnv(),
    timeoutMs: 600_000,
  });
  if (res.exitCode !== 0) {
    throw new ProviderError(`Codex image driver failed: ${res.stderr || res.stdout}`, "openai");
  }
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    throw new ProviderError(`Codex did not create a non-empty image at ${dest}`, "openai");
  }
  return { path: dest };
}

function buildCodexPrompt(userPrompt: string, outputPath: string): string {
  return [
    `Create exactly one image at ${outputPath}.`,
    "Do not modify any repository files.",
    "Use the attached reference images if present.",
    `Image request: ${userPrompt}`,
    `Reply with JSON only: {"status":"ok","path":"${outputPath}"}.`,
  ].join(" ");
}
