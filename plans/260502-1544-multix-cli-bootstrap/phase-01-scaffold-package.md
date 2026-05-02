# Phase 01 — Scaffold Package

## Context
- Plan: [plan.md](plan.md)
- Scout: [scout-260502-1544-source-scripts.md](../reports/scout-260502-1544-source-scripts.md)

## Overview
- Priority: P0 (blocker for all other phases)
- Status: pending
- Goal: stand up package skeleton, build, lint, bin entry; `multix --help` runs.

## Key Insights
- Single-bin `multix` package; ESM-only, Node >=20.
- Use `tsup` to bundle to `dist/cli.js` with shebang for `npx`.
- Biome over ESLint+Prettier (KISS, single tool, fast).
- Commander chosen over yargs: tree-of-commands style maps cleanly to `multix gemini ...` / `multix minimax ...`.

## Requirements
Functional:
- `package.json` with `bin: { multix: "./dist/cli.js" }`, `type: module`, `engines.node >=20`.
- `tsconfig.json` strict + NodeNext + declaration.
- Top-level `multix` shows help with placeholder subcommands: `check`, `gemini`, `minimax`, `openrouter`, `media`, `doc`.
- `npm run build` + `npm run dev` + `npm run lint` + `npm run typecheck` all pass.

Non-functional:
- Build <2s; cold `multix --help` <200ms.

## Architecture
```
src/
  cli.ts            # commander root; iterates registry; #!/usr/bin/env node shebang
  index.ts          # programmatic export
  commands/
    index.ts        # registry: () => Command[]
```
Shebang preserved by tsup `banner: { js: "#!/usr/bin/env node" }`.

## Related Code Files
Create:
- `package.json`, `tsconfig.json`, `tsup.config.ts`, `biome.json`, `.gitignore`, `.npmignore`
- `src/cli.ts`, `src/index.ts`, `src/commands/index.ts`

Modify: none.
Delete: none.

## Implementation Steps
1. `npm init -y`; set fields (`name=multix`, `version=0.0.1`, `type=module`, `bin`, `engines`, `files=["dist","skill","README.md","LICENSE"]`).
2. Install deps: `commander zod execa dotenv undici` (runtime); `typescript tsup vitest @biomejs/biome @types/node` (dev).
3. Write `tsconfig.json`: strict, target ES2022, module NodeNext, moduleResolution NodeNext, declaration true, outDir dist.
4. Write `tsup.config.ts`: entry `src/cli.ts`, format `esm`, target node20, banner shebang, clean true, dts true.
5. Write `biome.json`: formatter on, linter recommended, 2-space, no semi style preference irrelevant — let default.
6. Write `src/cli.ts` skeleton:
   ```ts
   #!/usr/bin/env node
   import { Command } from "commander";
   import { registerCommands } from "./commands/index.js";
   const program = new Command().name("multix").description("AI multimodal CLI").version("0.0.1");
   registerCommands(program);
   program.parseAsync(process.argv);
   ```
7. Write `src/commands/index.ts` exporting empty `registerCommands(program)` with placeholder `program.command("check").description("...")` stubs that print "not implemented" — replaced in later phases.
8. Add npm scripts: `build`, `dev` (tsup --watch), `start` (node dist/cli.js), `lint` (biome check .), `format` (biome format --write .), `typecheck` (tsc --noEmit), `test` (vitest run).
9. Add `.gitignore` (node_modules, dist, .env, multix-output, coverage).
10. Run `npm run build && node dist/cli.js --help` — verify output.

## Todo List
- [ ] package.json
- [ ] tsconfig.json
- [ ] tsup.config.ts
- [ ] biome.json
- [ ] .gitignore / .npmignore
- [ ] src/cli.ts skeleton
- [ ] src/commands/index.ts placeholder registry
- [ ] Verify `multix --help`

## Success Criteria
- `npm run build` succeeds; `dist/cli.js` is executable.
- `node dist/cli.js --help` prints all 6 top-level command names.
- `npm run typecheck` clean.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| ESM/CJS interop with deps | Med | Med | Pin ESM-friendly versions (commander v12+, execa v9+, undici native) |
| Shebang stripped on Windows | Low | Med | tsup banner + `chmod +x` postbuild script (no-op on Win) |
| Biome rules conflict with strict TS | Low | Low | Use `recommended` ruleset; tweak as needed |

## Security Considerations
- No secrets in repo; `.env` in `.gitignore`.
- `files` whitelist in package.json prevents accidental publish of tests/.env.

## Next Steps
Unblocks: phase-02. Phases 03-08 depend on 02 + the registry pattern from 01.
