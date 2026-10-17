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

function c(color: string, text: string, stream: NodeJS.WriteStream = process.stdout): string {
  // Skip ANSI if NO_COLOR is set or not a TTY
  if (process.env.NO_COLOR || !stream.isTTY) return text;
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

export interface LoggerOptions {
  verbose: boolean;
  /**
   * Send info/success/debug/header to stderr too, for commands whose stdout
   * is a machine-readable result (JSON) that must stay parseable.
   */
  stderr?: boolean;
}

export function createLogger(opts: LoggerOptions): Logger {
  const { verbose } = opts;
  // Looked up per call so console spies installed after creation still see the output.
  const out = (line: string) => (opts.stderr ? console.error(line) : console.log(line));
  const stream = opts.stderr ? process.stderr : process.stdout;
  return {
    info(msg) {
      out(c(ANSI.blue, `  ${msg}`, stream));
    },
    success(msg) {
      out(c(ANSI.green, `✓ ${msg}`, stream));
    },
    warn(msg) {
      console.warn(c(ANSI.yellow, `⚠ ${msg}`, process.stderr));
    },
    error(msg) {
      console.error(c(ANSI.red, `✗ ${msg}`, process.stderr));
    },
    debug(msg) {
      if (verbose) out(c(ANSI.dim, `  [debug] ${msg}`, stream));
    },
    header(msg) {
      const line = "=".repeat(60);
      out(c(ANSI.bold + ANSI.cyan, `\n${line}\n${msg}\n${line}\n`, stream));
    },
  };
}

/** Convenience singleton used when verbose flag is not yet parsed. */
export const defaultLogger: Logger = createLogger({ verbose: false });
