# Multix-CLI Provider Architecture Scout

**Codebase:** `/Volumes/GOON/www/oss/multix-cli-elevenlabs`  
**Reference Provider:** MiniMax (TTS/audio/speech analogous to ElevenLabs)  
**Report Date:** 2026-05-05

---

## 1. Provider Structure

**Location:** `/src/providers/{provider-name}/`

MiniMax tree (8 files):
```
src/providers/minimax/
  ├── client.ts                    # API wrapper + key resolution
  ├── models.ts                    # Constants (models, formats, defaults)
  ├── commands/
  │   ├── index.ts                 # Command group registrar
  │   ├── generate.ts              # Image generation command
  │   ├── generate-video.ts        # Video generation command
  │   ├── generate-speech.ts       # TTS/speech command
  │   └── generate-music.ts        # Music generation command
  └── generators/
      ├── speech.ts                # TTS impl: hex→bytes→WAV/MP3
      ├── music.ts
      ├── video.ts
      └── image.ts
```

**Roles:**
- `client.ts`: HTTP POST wrapper, auth headers, error handling (`apiPost<T>`)
- `models.ts`: Public constants exported for CLI (model IDs, formats, defaults)
- `commands/index.ts`: Single entry point; calls each command registrar on parent
- `commands/{task}.ts`: Command registration using Commander.js pattern
- `generators/{task}.ts`: Core logic; returns typed result (`SpeechResult`, etc.)

---

## 2. Command Registration Pattern

**Entry point:** `/src/commands/index.ts` (lines 1–26)
- Imports all `register{Provider}Commands` functions
- Called once by `cli.ts` before parsing argv

**Provider-level:** `/src/providers/minimax/commands/index.ts` (lines 12–20)
- Creates parent subcommand: `program.command("minimax")`
- Registers child commands: `generate`, `generate-video`, `generate-speech`, `generate-music`

**Command-level:** `/src/providers/minimax/commands/generate-speech.ts` (lines 12–70)
- `.command("generate-speech")`
- `.option()` chains for flags
- `.action()` handler: validates, calls generator, logs result, exits on error

**Pattern for new provider (e.g., ElevenLabs):**
1. Add to `src/commands/index.ts`: `import { registerElevenLabsCommands } from "../providers/elevenlabs/commands/index.js"`
2. Call: `registerElevenLabsCommands(program)`
3. Create `src/providers/elevenlabs/commands/index.ts` with same pattern

---

## 3. Core Helpers (`src/core/`)

**Key utilities all providers should use:**

| File | Exports | Purpose |
|------|---------|---------|
| `env-loader.ts` (61 lines) | `loadEnv()`, `resolveKey(name)`, `redact(key)` | Load `.env` from cwd + `~/.multix/`; resolve/mask API keys |
| `output-dir.ts` (32 lines) | `getOutputDir()` | Get/create output dir; respects `MULTIX_OUTPUT_DIR` env |
| `http-client.ts` (90+ lines) | `httpJson<T>(opts)`, `downloadFile(url, dest)`, `fetchBytes(url)` | Fetch + timeout (120s default) |
| `logger.ts` | `createLogger({verbose})` | Colored console output (debug, info, success, warn, error) |
| `errors.ts` | `ConfigError`, `ProviderError`, `ValidationError`, `HttpError` | Typed error classes |
| `result.ts` | `Result<T, E>` type, `ok(val)`, `err(val)` | Functional error handling |
| `video-thumb.ts` | `detectThumbUrl()`, `downloadThumbBeside()` | Extract/save thumbnails |

**Auto-import via:** `/src/core/index.ts` (barrel export, 15 lines)

---

## 4. Env Vars & Validation

**Pattern:**

```typescript
// client.ts
export function requireMinimaxKey(): string {
  const key = resolveKey("MINIMAX_API_KEY");
  if (!key) {
    throw new ConfigError(
      "MINIMAX_API_KEY is not set. Get one at https://...",
    );
  }
  return key;
}
```

**Resolution order (env-loader.ts lines 4–10):**
1. `process.env` (highest priority — never overwritten)
2. `.env` in cwd
3. `~/.multix/.env` (skip if `MULTIX_DISABLE_HOME_ENV=1`)

**For ElevenLabs:**
- Add `ELEVENLABS_API_KEY` env var
- Create `requireElevenLabsKey()` in `src/providers/elevenlabs/client.ts`
- Validate on first command action, before any API call

---

## 5. Output Conventions

**Audio/file naming:** (minimax/generators/speech.ts lines 84–88)
```typescript
const ext = ["mp3", "wav", "flac"].includes(outputFormat) ? outputFormat : "mp3";
const outDir = getOutputDir();
const dest = path.join(outDir, `minimax_speech_${Date.now()}.${ext}`);
fs.writeFileSync(dest, audioBytes);
logger?.success(`Saved: ${dest} (${(audioBytes.length / 1024).toFixed(1)} KB)`);
```

**Convention:**
- Output dir: `./multix-output` (or `$MULTIX_OUTPUT_DIR`)
- Filename: `{provider}_{task}_{timestamp}.{ext}`
- If `--output <path>` provided: copy result there too
- Log with `logger.success()` showing filename + size

---

## 6. Testing Layout & Framework

**Framework:** Vitest v2.1.8  
**Pattern:** `tests/{smoke|unit}/{category}/{entity}.test.ts`

**Example test file:** `tests/unit/core/env-loader.test.ts` (50 lines)
- Assertions: `expect()` matcher API (`toMatch`, `toBe`, `toBeUndefined`)
- Hooks: `beforeEach`, `afterEach`, `describe`, `it`
- Mocking: `vi.mock()`, spy functions
- Reset helpers: `_resetEnvLoader()` called in before/after

**Vitest config:** `/vitest.config.ts`
- Test patterns: `tests/**/*.test.ts`
- Env: `MULTIX_DISABLE_HOME_ENV=1` set globally (lines omitted but referenced in tests)

**To add tests for ElevenLabs:**
- Create `tests/unit/providers/elevenlabs/client.test.ts`
- Mock `globalThis.fetch` with helper from `tests/helpers/mock-fetch.ts`
- Test key validation, error handling, result shapes

---

## 7. Build & Package Config

**package.json scripts (lines 21–31):**
```json
"build": "tsup",
"dev": "tsup --watch",
"start": "node dist/cli.js",
"lint": "biome check .",
"format": "biome format --write .",
"typecheck": "tsc --noEmit",
"test": "vitest run",
"test:watch": "vitest",
"test:smoke": "vitest run tests/smoke"
```

**tsconfig.json (25 lines):**
- Target: ES2022, Module: NodeNext
- Strict mode on; `noUncheckedIndexedAccess: true`
- Output: `./dist`, source: `./src`

**Biome config (31 lines):**
- Formatter: 2-space indent, 100-char line width
- Linter: recommended rules; `noExplicitAny` = warn
- Import organization: enabled
- Ignore: `dist/**`, `node_modules/**`, `*.d.ts`

---

## 8. Existing TTS/Audio Code (Minimax)

**Speech generation impl:** `/src/providers/minimax/generators/speech.ts` (98 lines)

**Audio decode & save** (lines 78–89):
```typescript
const audioHex = resp.data?.audio;  // API returns hex string
if (!audioHex) {
  return { status: "error", error: "No audio in response" };
}

const audioBytes = Buffer.from(audioHex, "hex");
const ext = ["mp3", "wav", "flac"].includes(outputFormat) ? outputFormat : "mp3";
const outDir = getOutputDir();
const dest = path.join(outDir, `minimax_speech_${Date.now()}.${ext}`);

fs.writeFileSync(dest, audioBytes);
logger?.success(`Saved: ${dest} (${(audioBytes.length / 1024).toFixed(1)} KB)`);

if (output) {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.copyFileSync(dest, output);
}

return { status: "success", generatedAudio: dest, model };
```

**API interaction** (lines 73–75):
```typescript
resp = await apiPost<SpeechResponse>("t2a_v2", payload, apiKey, { logger });
```

**For ElevenLabs TTS:**
- Call ElevenLabs API to get audio stream (likely Buffer, not hex)
- Write directly: `fs.writeFileSync(dest, buffer)`
- Support MP3 + WAV formats (match ElevenLabs API capabilities)
- Return `SpeechResult` typed object with `status`, `generatedAudio`, `error`

---

## 9. README Provider Sections

**Location:** `/README.md` lines 116–132

**Format:**
```markdown
### `multix {provider}`

\`\`\`bash
# Command 1
multix {provider} {command} --flag <type> [--option <type>] [-v]

# Command 2
multix {provider} {command} --flag <type> [--option <type>] [-v]
\`\`\`

**{Provider} models:** model1, model2, model3 (and more — see `--help`)
```

**Pattern:**
- Subheading: `### \`multix {provider}\``
- Code block: bash examples with inline comments
- Models line: comma-sep list + "see `--help`" note
- Flags shown with defaults and constraints in comments

---

## Summary Table

| Aspect | Location | Key Pattern |
|--------|----------|-------------|
| **Provider files** | `src/providers/{name}/` | client.ts, commands/, generators/, models.ts |
| **Command registration** | `src/commands/index.ts` → `src/providers/{name}/commands/index.ts` | Import + call registrar |
| **API auth** | `client.ts` `require{Provider}Key()` | `resolveKey()` + `ConfigError` on missing |
| **Output** | `getOutputDir()` + `{provider}_{task}_{ts}.{ext}` | Use core helper, fs.writeFileSync |
| **Env loading** | `src/core/env-loader.ts` + CLI entry `loadEnv()` | Called in cli.ts before parse |
| **Testing** | `tests/unit/providers/{name}/` | Vitest, `expect()`, mock fetch |
| **Build** | `npm run build` (tsup) | tsconfig.json strict mode |
| **Lint** | `npm run lint` (biome) | 100-char line, 2-space indent |

---

## For ElevenLabs Integration

1. **Create structure:**
   - `src/providers/elevenlabs/{client.ts, models.ts, commands/index.ts, commands/generate-tts.ts, generators/speech.ts}`

2. **Add to command registry:**
   - Import + call in `src/commands/index.ts`

3. **Env vars:**
   - Add `ELEVENLABS_API_KEY` to `.env` examples
   - Implement `requireElevenLabsKey()` with ConfigError

4. **Output:**
   - Use `getOutputDir()` + `elevenlabs_speech_{ts}.{ext}` naming
   - Support MP3, WAV (match API)

5. **README:**
   - Add section after MiniMax (line ~132)
   - Show `multix elevenlabs generate-tts --text "..." [--voice <id>] [--format mp3|wav]`

