/**
 * Check if external tool binaries (ffmpeg, magick) are available on PATH.
 * Uses try-execute approach that works cross-platform:
 * - POSIX: ENOENT code when binary is not found
 * - Windows: exit code 1 + "not recognized" in stderr
 */

import { execa } from "execa";

export interface BinaryStatus {
  available: boolean;
  version?: string;
  binary: string;
}

/** Try to run `binary --version` and return availability + version string. */
export async function checkBinary(binary: string): Promise<BinaryStatus> {
  try {
    const result = await execa(binary, ["--version"], { reject: true, all: true });
    // Extract first line of version output
    const version = (result.stdout || result.stderr || "").split("\n")[0]?.trim();
    return { available: true, version, binary };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { exitCode?: number; stderr?: string; all?: string };

    // POSIX: ENOENT means binary not on PATH
    if (err.code === "ENOENT") return { available: false, binary };

    // Windows: cmd/PowerShell prints "not recognized" for missing binaries
    const output = (err.stderr ?? err.all ?? "").toLowerCase();
    if (output.includes("not recognized") || output.includes("not found") || output.includes("no such file")) {
      return { available: false, binary };
    }

    // Binary exists but returned non-zero exit code (e.g. some ffmpeg builds on --version)
    if (err.exitCode !== undefined) return { available: true, binary };

    // Unknown error — treat as unavailable
    return { available: false, binary };
  }
}
