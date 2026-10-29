import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOutputFileTracker, producedFiles } from "../../../src/agent/output-file-tracker.js";
import { run } from "../../../src/agent/run-state.js";
import { _resetOutputDir } from "../../../src/core/output-dir.js";

describe("producedFiles", () => {
  let base: string;

  function write(...parts: string[]): string {
    const file = path.join(base, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    run.written.add(file);
    return file;
  }

  /** os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows. */
  function stubTmpDir(dir: string): void {
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, dir);
  }

  /** os.homedir() reads HOME on POSIX and USERPROFILE on Windows. */
  function stubHomeDir(dir: string): void {
    for (const name of ["HOME", "USERPROFILE"]) vi.stubEnv(name, dir);
  }

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "multix-tracker-")));
    run.written.clear();
    _resetOutputDir();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetOutputDir();
    run.written.clear();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("reports files under a MULTIX_OUTPUT_DIR inside the temp dir", () => {
    vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(base, "out"));
    const image = write("out", "gemini_0.png");
    const nested = write("out", "frames", "f1.png");
    const scratch = write("scratch", "upload.bin");
    expect(producedFiles().sort()).toEqual([nested, image].sort());
    expect(producedFiles()).not.toContain(scratch);
  });

  it("still drops temp files when the output dir is elsewhere", () => {
    vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(os.homedir(), "multix-tracker-unused"));
    write("scratch", "upload.bin");
    expect(producedFiles()).toEqual([]);
  });

  it("reports an explicit --output and --output-dir under the temp dir", () => {
    vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(os.homedir(), "multix-tracker-unused"));
    const explicit = write("explicit.png");
    const inDir = write("chosen", "a.png");
    write("scratch", "upload.bin");
    expect(producedFiles([explicit], [path.join(base, "chosen")]).sort()).toEqual(
      [explicit, inDir].sort(),
    );
  });

  it("skips partial and temp-suffixed files inside the output dir", () => {
    vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(base, "out"));
    write("out", "video.mp4.part");
    write("out", "video.mp4.tmp");
    expect(producedFiles()).toEqual([]);
  });

  it("reports a child whose name starts with two dots", () => {
    vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(base, "out"));
    const file = write("out", "..cache", "a.png");
    expect(producedFiles()).toEqual([file]);
  });

  it("counts only direct children when the output dir is the temp root", () => {
    stubTmpDir(base);
    vi.stubEnv("MULTIX_OUTPUT_DIR", base);
    const direct = write("result.png");
    write("scratch", "upload.bin");
    expect(producedFiles()).toEqual([direct]);
  });

  it("drops temp files when the output dir contains the temp dir", () => {
    stubTmpDir(path.join(base, "user"));
    vi.stubEnv("MULTIX_OUTPUT_DIR", base);
    fs.mkdirSync(path.join(base, "user"));
    const result = write("result.png");
    write("user", "multix-stdin-1", "stdin.png");
    write("user", "loose.png");
    expect(producedFiles()).toEqual([result]);
  });

  it("drops ~/.multix state but keeps sibling dirs that share the prefix", () => {
    stubHomeDir(base);
    // The output dir holds ~/.multix too, so only the state rule can drop it.
    vi.stubEnv("MULTIX_OUTPUT_DIR", base);
    write(".multix", "history.jsonl");
    const output = write(".multix-out", "a.png");
    expect(producedFiles()).toEqual([output]);
  });

  it("drops a file named exactly ~/.multix", () => {
    stubHomeDir(base);
    vi.stubEnv("MULTIX_OUTPUT_DIR", base);
    write(".multix");
    expect(producedFiles()).toEqual([]);
  });

  it("records a file: URL target as its decoded path, and untracks a renamed URL", () => {
    installOutputFileTracker();
    vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(base, "out"));
    fs.mkdirSync(path.join(base, "out"));
    const first = path.join(base, "out", "a b.png");
    const renamed = path.join(base, "out", "c d.png");
    fs.writeFileSync(pathToFileURL(first), "x");
    expect(producedFiles()).toEqual([first]);
    fs.renameSync(pathToFileURL(first), pathToFileURL(renamed));
    expect([...run.written]).toEqual([renamed]);
    expect(producedFiles()).toEqual([renamed]);
  });
});
