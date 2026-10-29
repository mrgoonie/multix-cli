import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { producedFiles } from "../../../src/agent/output-file-tracker.js";
import { run } from "../../../src/agent/run-state.js";
import { _resetOutputDir } from "../../../src/core/output-dir.js";

let root: string;
let savedOutputDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "multix-produced-"));
  savedOutputDir = process.env.MULTIX_OUTPUT_DIR;
  run.written.clear();
  _resetOutputDir();
});

afterEach(() => {
  if (savedOutputDir === undefined) Reflect.deleteProperty(process.env, "MULTIX_OUTPUT_DIR");
  else process.env.MULTIX_OUTPUT_DIR = savedOutputDir;
  run.written.clear();
  _resetOutputDir();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  run.written.add(file);
  return file;
}

describe("producedFiles", () => {
  it("keeps files in an output directory that lives under the OS temp dir", () => {
    process.env.MULTIX_OUTPUT_DIR = path.join(root, "out");
    const image = write(path.join(root, "out", "image.png"));
    const nested = write(path.join(root, "out", "sub", "clip.mp4"));
    expect(producedFiles().sort()).toEqual([image, nested].sort());
  });

  it("still drops scratch files elsewhere under the OS temp dir", () => {
    process.env.MULTIX_OUTPUT_DIR = path.join(root, "out");
    write(path.join(root, "scratch", "frame.png"));
    write(path.join(root, "out-sibling", "frame.png"));
    expect(producedFiles()).toEqual([]);
  });

  it("keeps an explicit --output path under the OS temp dir", () => {
    process.env.MULTIX_OUTPUT_DIR = path.join(root, "out");
    const target = write(path.join(root, "elsewhere", "copy.png"));
    expect(producedFiles([target])).toEqual([target]);
  });
});
