# Review: PR #132 fix(build): ship the programmatic entry point (closes #131)

Head 6f1734e. Files: `tsup.config.ts` (+13/-5), `src/cli.ts` (+1), `tests/smoke/library-entry.test.ts` (+86). `src/index.ts` and `package.json` are unchanged.
Evidence: built `dist/` in agent-ada6b9a6d16064ee2 was read directly. CI is 6/6 green, including Node 20 and 22 on windows-latest and ubuntu-latest. Bash was dead in this session, so `npm pack` and local test runs were not possible.

## Verdict: APPROVE (no blockers). One maintainer decision is needed before the first publish (M1).

## Verified
- `dist/cli.js:1` is `#!/usr/bin/env node`, and `dist/index.js:1` has no shebang. esbuild keeps an entry's hashbang. tsup's shebang handling still marks outputs that start with `#!` as executable, so it works without the banner. npm's cmd-shim reads the shebang on Windows, so the bin behaves as before.
- `dist/index.js` has no top-level side effects: no argv parsing, no `loadEnv` call, no `process.exit`. Module scope only declares state. `defaultLogger` (`src/core/logger.ts:60`) only builds closures, and its TTY/NO_COLOR check runs when called. `getOutputDir` is lazy.
- `dist/index.d.ts` is self-contained: there is no relative `from './…'`, and the core types are inlined through `export *`. The local `loadEnv` (optional options) correctly shadows the core `loadEnv` that `export *` brings in (`dist/index.js:1157,1186`). `tsconfig.json` excludes `tests`, `worker/` is outside `src/`, and dts is limited to the `index` entry.
- One config with `clean: true` avoids the clean race between two configs.

## Medium
**M1. The public API becomes semver-bound, including internals** (`src/index.ts:8` re-exports everything from `src/core/index.ts`). These are now exported and published (`dist/index.d.ts:344`):
- test-only `_resetEnvLoader` and `_resetOutputDir`
- CLI-flavoured helpers `parseJsonInput` (reads `@file`), `maybeDownloadThumb`, `downloadThumbBeside`, `getOutputDir` (mkdir in cwd), `defaultLogger`, `httpJson`, `downloadFile`, `fetchBytes`

This was not introduced by the PR, but the PR makes it real. Because the entry never worked before, no consumer depends on it yet, which makes now the cheapest moment to trim it. Options:
- (a) Ship as is.
- (b) Switch to an explicit named export list in `src/index.ts` that drops the `_reset*` helpers and the output-dir and thumb helpers.
- (c) Mark them `/** @internal */` and turn on `stripInternal` for dts.

This is the maintainer's call and does not block the PR.

## Low
- **L1. Duplicated module state between bundles.** `splitting: false` means `dist/cli.js` (13.6k lines) and `dist/index.js` each carry their own copy of env-loader (`loaded`, `warned`, `fileOrigins`), the output-dir memo, and the error classes. `instanceof MultixError` fails across the two bundles. This only matters if one process loads both. `cli.js` is not importable as a library (it parses argv and exits), so the practical risk is near zero. A one-line comment in `tsup.config.ts` would record this.
- **L2. Weak side-effect assertions in the smoke test** (`tests/smoke/library-entry.test.ts:47-74`):
  - `MULTIX_OUTPUT_DIR` is set to `tmp` itself, so an eager `mkdirSync(outputDir)` at import would go unnoticed because the directory already exists. Point it at `path.join(tmp, "out")` and assert that it does not exist.
  - Nothing directly checks that `loadEnv` does not run at import. Only an incidental stderr warning would catch it, and only if `ROOT/.env` holds refused names. Have the probe compare a sentinel such as `Object.keys(process.env).length`, or write a `.env` in a temp cwd containing an allowed name and assert it stays unset.
  - The child process uses `execa("node", …)` with `reject: false` and a timeout, which is robust on Windows (CI green). I see no flake vector.
- **L3. Consumer typings need `@types/node`.** `dist/index.d.ts:331` uses `NodeJS.Platform`, `:188` uses `Buffer`, and `RequestInit`/`Response` are used throughout. This is acceptable for a Node-only library, but worth one line in the README section on programmatic use.
- **L4. Export conditions (pre-existing, `package.json:12-15`).** `"import"` is listed before `"types"`, and there is no `"default"` condition. TypeScript still resolves the sibling `index.d.ts`, so this works. Putting `types` first and adding `default` follows the recommended layout and makes `require(esm)` work on Node 22. Optional.

## Info
- **Release-please:** a `fix(build):` commit produces a patch bump (1.0.6 to 1.0.7). One could argue for `feat:`, since it delivers a working library API for the first time. Maintainer choice; it matters if M1 option (a) is taken.
- **Package size:** about +1.2k lines of JS (`dist/index.js`) and 345 lines of `.d.ts`, against the 13.6k-line `cli.js`. I estimate tens of KB unpacked. Not measured, because `npm pack` could not run.

## Unresolved questions
1. Should the library surface be trimmed (M1) before the first release that actually ships `dist/index.js`?
2. Should this release as `fix` (patch) or `feat` (minor)?
