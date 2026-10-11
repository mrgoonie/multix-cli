/**
 * Environment for smoke-test child processes that must not reach a paid API or
 * write into the user's real output directory.
 */

/** Gemini/Google credentials and the output-dir override inherited from the parent shell. */
const STRIPPED = /^(GEMINI_API_KEY(_\w+)?|GOOGLE_\w+|MULTIX_OUTPUT_DIR)$/i;

/**
 * Copy the parent env without Gemini/Google keys, then pin temp and output
 * directories to `tmp`. Pass with `extendEnv: false` so nothing else leaks back in.
 */
export function isolatedEnv(tmp: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !STRIPPED.test(name)),
  );
  return {
    ...env,
    MULTIX_DISABLE_HOME_ENV: "1",
    MULTIX_OUTPUT_DIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
  };
}
