/**
 * Simple ANSI-coloured logger for multix CLI.
 * Uses no external deps — raw ANSI escape codes only.
 * debug() is a no-op unless verbose mode is enabled.
 * With `stderr: true` every line goes to stderr, so a command whose stdout is
 * machine-readable (JSON) keeps it parseable.
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

export function createLogger(opts: { verbose: boolean; stderr?: boolean }): Logger {
  const { verbose } = opts;
  const out = opts.stderr ? process.stderr : process.stdout;
  const print = (text: string) => (opts.stderr ? console.error(text) : console.log(text));
  const paint = (color: string, text: string) => c(color, text, out);
  return {
    info(msg) {
      print(paint(ANSI.blue, `  ${msg}`));
    },
    success(msg) {
      print(paint(ANSI.green, `✓ ${msg}`));
    },
    warn(msg) {
      console.warn(c(ANSI.yellow, `⚠ ${msg}`));
    },
    error(msg) {
      console.error(c(ANSI.red, `✗ ${msg}`));
    },
    debug(msg) {
      if (verbose) print(paint(ANSI.dim, `  [debug] ${msg}`));
    },
    header(msg) {
      const line = "=".repeat(60);
      print(paint(ANSI.bold + ANSI.cyan, `\n${line}\n${msg}\n${line}\n`));
    },
  };
}

/** Convenience singleton used when verbose flag is not yet parsed. */
export const defaultLogger: Logger = createLogger({ verbose: false });
