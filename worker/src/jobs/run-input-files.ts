/**
 * `multix_run` file inputs: the caller names a file option or positional and
 * gives public https URLs; the server chooses the local path each URL is
 * downloaded to (under `in/` in the job directory) and puts that path into
 * argv. A caller never writes a path the CLI reads.
 */

import { ValidationError } from "../../../src/core/errors.js";
import { assertPublicHttpsUrl } from "../url-guard.js";
import type { FileInputKind } from "./cli-command-policy.js";
import type { JobInputFile } from "./job-protocol.js";

/** Most files one job may download. */
export const MAX_INPUT_FILES = 10;

export interface FileTarget {
  kind: FileInputKind;
  /** More than one URL allowed (repeatable option, variadic positional, or a directory). */
  multiple: boolean;
}

export interface ResolvedInputs {
  /** Local path(s) per option or positional name, in the caller's order. */
  paths: Map<string, string[]>;
  files: JobInputFile[];
}

/** Last URL path segment reduced to safe characters, keeping the extension the CLI may sniff. */
export function safeFileName(url: string): string {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Keep the raw segment; it is reduced to safe characters below.
  }
  const cleaned = decoded
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[.]+/, "")
    .slice(-80);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "input";
}

function urlList(name: string, raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw new ValidationError(`inputs.${name} must not be empty`);
  return list.map((value, i) => {
    if (typeof value !== "string") {
      throw new ValidationError(`inputs.${name} must be an https URL or a list of them`);
    }
    return assertPublicHttpsUrl(
      value,
      Array.isArray(raw) ? `inputs.${name}[${i}]` : `inputs.${name}`,
    );
  });
}

export function resolveInputs(
  inputs: Readonly<Record<string, unknown>> | undefined,
  targets: ReadonlyMap<string, FileTarget>,
): ResolvedInputs {
  const resolved: ResolvedInputs = { paths: new Map(), files: [] };
  for (const [rawName, raw] of Object.entries(inputs ?? {})) {
    const name = rawName.replace(/^-+/, "");
    const target = targets.get(name);
    if (!target) {
      throw new ValidationError(
        `inputs.${name} is not a file input of this command (see multix_catalog)`,
      );
    }
    const urls = urlList(name, raw);
    if (urls.length > 1 && !target.multiple) {
      throw new ValidationError(`inputs.${name} takes a single URL`);
    }
    const paths: string[] = [];
    for (const url of urls) {
      const index = resolved.files.length;
      if (index >= MAX_INPUT_FILES) {
        throw new ValidationError(`At most ${MAX_INPUT_FILES} input files per run`);
      }
      const file = `${index}-${safeFileName(url)}`;
      const path = target.kind === "dir" ? `in/${name}/${file}` : `in/${file}`;
      resolved.files.push({ url, path });
      paths.push(path);
    }
    resolved.paths.set(name, target.kind === "dir" ? [`in/${name}`] : paths);
  }
  return resolved;
}
