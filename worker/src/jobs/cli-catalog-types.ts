/**
 * Shape of src/cli-catalog.json: every multix command, its positionals and
 * options, dumped from the CLI's commander program by
 * scripts/build-cli-catalog.ts (`npm run catalog`).
 */

export interface CliOption {
  /** Long flag, e.g. `--num-images` (the flags string when a flag has no long form). */
  long: string;
  /** Short flag, e.g. `-n`. */
  short?: string;
  /** Commander flags string, e.g. `-n, --num-images <n>`. */
  flags: string;
  description: string;
  /** Declared with requiredOption(): must be given. */
  required: boolean;
  /** Takes a value (`<x>` or `[x]`). */
  takesValue: boolean;
  /** The value is optional (`[x]`). */
  valueOptional: boolean;
  /** `<x...>`: takes several values. */
  variadic: boolean;
  /** A `--no-*` flag. */
  negatable: boolean;
  default?: string | number | boolean | string[];
}

export interface CliPositional {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  default?: string | number | boolean | string[];
}

export interface CliCommand {
  /** Space-separated path, e.g. `gemini generate` or `elevenlabs voices list`. */
  command: string;
  description: string;
  positionals: CliPositional[];
  options: CliOption[];
}

export interface CliGroup {
  /** Top-level command name, e.g. `gemini`. */
  group: string;
  description: string;
  commands: CliCommand[];
}

export interface CliCatalog {
  groups: CliGroup[];
}
