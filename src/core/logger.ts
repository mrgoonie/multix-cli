/**
 * Simple ANSI-coloured logger for multix CLI.
 * Uses no external deps — raw ANSI escape codes only.
 * debug() is a no-op unless verbose mode is enabled.
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
} as const;

function c(color: string, text: string): string {
  // Skip ANSI if NO_COLOR is set or not a TTY
  if (process.env["NO_COLOR"] || !process.stdout.isTTY) return text;
  return `${color}${text}${ANSI.reset}`;
}

export interface Logger {
  info(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
  /** Print a section header. */
  header(msg: string): void;
}

export function createLogger(opts: { verbose: boolean }): Logger {
  const { verbose } = opts;
  return {
    info(msg) {
      console.log(c(ANSI.blue, `  ${msg}`));
    },
    success(msg) {
      console.log(c(ANSI.green, `✓ ${msg}`));
    },
    warn(msg) {
      console.warn(c(ANSI.yellow, `⚠ ${msg}`));
    },
    error(msg) {
      console.error(c(ANSI.red, `✗ ${msg}`));
    },
    debug(msg) {
      if (verbose) console.log(c(ANSI.dim, `  [debug] ${msg}`));
    },
    header(msg) {
      const line = "=".repeat(60);
      console.log(c(ANSI.bold + ANSI.cyan, `\n${line}\n${msg}\n${line}\n`));
    },
  };
}

/** Convenience singleton used when verbose flag is not yet parsed. */
export const defaultLogger: Logger = createLogger({ verbose: false });
