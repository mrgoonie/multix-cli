/**
 * Registers the `elevenlabs` command group and all subcommands.
 */

import type { Command } from "commander";
import { registerAccountCommands } from "./account.js";
import { registerAlignCommand } from "./align.js";
import { registerCloneCommand } from "./clone.js";
import { registerDubCommand } from "./dub.js";
import { registerIsolateCommand } from "./isolate.js";
import { registerMusicCommand } from "./music.js";
import { registerSfxCommand } from "./sfx.js";
import { registerTranscribeCommand } from "./transcribe.js";
import { registerTtsCommand } from "./tts.js";
import { registerVoiceChangerCommand } from "./voice-changer.js";
import { registerVoicesCommand } from "./voices.js";

export function registerElevenLabsCommands(program: Command): void {
  const el = program
    .command("elevenlabs")
    .description(
      "ElevenLabs: TTS, voices, cloning, STT, voice changer, SFX, music, dubbing, isolation, alignment",
    );

  registerTtsCommand(el);
  registerVoicesCommand(el);
  registerCloneCommand(el);
  registerVoiceChangerCommand(el);
  registerTranscribeCommand(el);
  registerSfxCommand(el);
  registerMusicCommand(el);
  registerDubCommand(el);
  registerIsolateCommand(el);
  registerAlignCommand(el);
  registerAccountCommands(el);
}
