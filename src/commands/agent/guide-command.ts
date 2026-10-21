/**
 * `multix guide` — the agent protocol in one screen: how to discover a
 * command, validate before paying, read results, recover from errors, follow
 * async jobs and review history. Kept short on purpose (token budget).
 */

import type { Command } from "commander";
import { run } from "../../agent/run-state.js";
import { EXIT_CODES } from "../../core/error-classify.js";
import { modelRows } from "./models-command.js";

export const GUIDE_TEXT = `multix agent protocol
1. Discover: multix models --task <task> --ready   (tasks: image, image-edit, video, image-to-video,
   video-edit, speech, transcription, music, sfx, voice, 3d, analysis, document, avatar-video, any)
   Flags of one command: multix <group> <command> --help
2. Validate for free: add --dry-run. Local checks run; the first provider request is shown, not sent.
3. Run with --json (or MULTIX_OUTPUT=json): stdout is ONE line, schema multix.result/v1:
   ok, outputs[{path,bytes,mime,sha256,width,height,duration_s}], warnings[], text|data,
   error{code,retryable,retry_after_s,hint}, usage{tokens,cost_usd,credits,metrics}, history_id, next[]
4. Check the result yourself: ok=true AND outputs non-empty AND no warnings (EMPTY_OUTPUT,
   CONTENT_MISMATCH, UNREADABLE_MEDIA). Look at images/video only when it matters.
5. On failure follow error.hint and next[]; never resubmit a paid job blindly:
   exit ${EXIT_CODES.usage} usage/invalid input -> fix flags       exit ${EXIT_CODES.config} key/config -> multix check
   exit ${EXIT_CODES.retryable} temporary -> wait, multix rerun <id>   exit ${EXIT_CODES.rejected} rejected (quota, safety, model) -> change input/provider
   exit ${EXIT_CODES.timeout} timed out, job may still run -> use the status command in next[], do not resubmit
6. Long jobs: pass --async (or --no-wait) where offered, keep the job id, run the status command in next[].
7. History: multix history [--failed] | history show last | history stats --by model | rerun <id>
   Ledger ~/.multix/history.jsonl records outputs, tokens, cost, credits, duration (MULTIX_HISTORY=0 disables).`;

export function registerGuideCommand(program: Command): void {
  program
    .command("guide")
    .description(
      "Agent protocol in one screen: discover, dry-run, --json envelope, errors, history",
    )
    .action(() => {
      const ready = [
        ...new Set(
          modelRows(program)
            .filter((r) => r.ready)
            .map((r) => r.provider),
        ),
      ];
      if (run.json) {
        console.log(JSON.stringify({ guide: GUIDE_TEXT, ready_providers: ready }));
        return;
      }
      console.log(GUIDE_TEXT);
      console.log(
        `Ready providers (key set): ${ready.length ? ready.join(", ") : "none — run multix check"}`,
      );
    });
}
