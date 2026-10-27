/**
 * Custom deterministic rules for `media verify`. A rule is a local script
 * that reads one JSON document on stdin (the source digest, the inspect
 * report and the measured ranges) and prints one JSON verdict on stdout.
 * It runs without a shell, in an empty temp directory, with only PATH in its
 * environment (no API keys), under a timeout and an output cap.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { ValidationError } from "../../core/errors.js";

export const RULE_INPUT_SCHEMA = "multix.media-rule-input/v1";
export const RULE_OUTPUT_LIMIT_BYTES = 1024 * 1024;

const outputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    version: z.union([z.number(), z.string()]),
    status: z.enum(["pass", "fail", "warn", "unknown"]),
    message: z.string().max(2000).optional(),
    findings: z
      .array(
        z
          .object({
            start_s: z.number().min(0).optional(),
            end_s: z.number().min(0).optional(),
            message: z.string().max(2000),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
  })
  .strict();

export type RuleVerdict = z.infer<typeof outputSchema>;

export interface RuleRun {
  file: string;
  sha256: string;
  verdict?: RuleVerdict;
  error?: string;
}

/** Interpreter for a rule script by extension; an extensionless file runs directly. */
export function ruleCommand(file: string): { program: string; args: string[] } {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs")
    return { program: process.execPath, args: ["--max-old-space-size=256", file] };
  if (ext === ".py")
    return { program: process.platform === "win32" ? "python" : "python3", args: ["-I", file] };
  if (ext === ".sh") return { program: "sh", args: [file] };
  return { program: file, args: [] };
}

export function resolveRuleFile(file: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(file);
  } catch {
    throw new ValidationError(`Rule file not found: ${file}`);
  }
  if (!fs.statSync(resolved).isFile())
    throw new ValidationError(`Rule is not a regular file: ${file}`);
  return resolved;
}

/** Only what a process needs to start: PATH, plus SystemRoot on Windows. No keys. */
function ruleEnv(): Record<string, string> {
  const { PATH = "", SystemRoot } = process.env;
  return process.platform === "win32" && SystemRoot ? { PATH, SystemRoot } : { PATH };
}

export async function runRule(
  file: string,
  sha256: string,
  input: unknown,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<RuleRun> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "multix-rule-"));
  try {
    const { program, args } = ruleCommand(file);
    const res = await execa(program, args, {
      cwd,
      input: JSON.stringify(input),
      reject: false,
      timeout: opts.timeoutMs,
      cancelSignal: opts.signal,
      maxBuffer: RULE_OUTPUT_LIMIT_BYTES,
      extendEnv: false,
      env: ruleEnv(),
    });
    if (res.timedOut) return { file, sha256, error: `rule timed out after ${opts.timeoutMs} ms` };
    if (res.isCanceled) return { file, sha256, error: "rule was cancelled" };
    if (res.isMaxBuffer)
      return { file, sha256, error: `rule output exceeded ${RULE_OUTPUT_LIMIT_BYTES} bytes` };
    if (res.exitCode !== 0)
      return {
        file,
        sha256,
        error: `rule exited with code ${res.exitCode}: ${String(res.stderr ?? "")
          .trim()
          .slice(-500)}`,
      };
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(res.stdout));
    } catch {
      return { file, sha256, error: "rule printed invalid JSON" };
    }
    const verdict = outputSchema.safeParse(parsed);
    if (!verdict.success)
      return {
        file,
        sha256,
        error: `rule output invalid: ${verdict.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      };
    return { file, sha256, verdict: verdict.data };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
