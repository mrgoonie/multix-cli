/**
 * Command registry — all top-level subcommand groups are registered here.
 * Each provider/command phase appends its registrar; cli.ts calls registerCommands once.
 */

import type { Command } from "commander";
import { checkImageFormatBeforeAction } from "../core/image-webp-finalize.js";
import { registerAtlasCloudCommands } from "../providers/atlascloud/commands/index.js";
import { registerBytePlusCommands } from "../providers/byteplus/commands/index.js";
import { registerCloudflareCommands } from "../providers/cloudflare/commands/index.js";
import { registerElevenLabsCommands } from "../providers/elevenlabs/commands/index.js";
import { registerFalCommands } from "../providers/fal/commands/index.js";
import { registerFishCommands } from "../providers/fish/commands/index.js";
import { registerGeminiCommands } from "../providers/gemini/commands/index.js";
import { registerHeygenCommands } from "../providers/heygen/commands/index.js";
import { registerLeonardoCommands } from "../providers/leonardo/commands/index.js";
import { registerMinimaxCommands } from "../providers/minimax/commands/index.js";
import { registerOpenAICommands } from "../providers/openai/commands/index.js";
import { registerOpenRouterCommands } from "../providers/openrouter/commands/index.js";
import { registerReplicateCommands } from "../providers/replicate/commands/index.js";
import { registerRunwayCommands } from "../providers/runway/commands/index.js";
import { registerSumeCommands } from "../providers/sume/commands/index.js";
import { registerTopviewCommands } from "../providers/topview/commands/index.js";
import { registerCatalogCommands } from "./agent/catalog-command.js";
import { registerGuideCommand } from "./agent/guide-command.js";
import { registerHistoryCommands } from "./agent/history-command.js";
import { registerModelsCommand } from "./agent/models-command.js";
import { registerCheckCommand } from "./check.js";
import { registerDocCommands } from "./doc/index.js";
import { registerMediaCommands } from "./media/index.js";
import { registerSceneCommands } from "./scene/index.js";
import { registerSpeechCommands } from "./speech/index.js";
import { registerUpdateCommand } from "./update.js";

export function registerCommands(program: Command): void {
  checkImageFormatBeforeAction(program);
  registerCheckCommand(program);
  registerUpdateCommand(program);
  registerGeminiCommands(program);
  registerMinimaxCommands(program);
  registerOpenAICommands(program);
  registerOpenRouterCommands(program);
  registerLeonardoCommands(program);
  registerBytePlusCommands(program);
  registerCloudflareCommands(program);
  registerElevenLabsCommands(program);
  registerFalCommands(program);
  registerFishCommands(program);
  registerAtlasCloudCommands(program);
  registerReplicateCommands(program);
  registerRunwayCommands(program);
  registerHeygenCommands(program);
  registerSumeCommands(program);
  registerTopviewCommands(program);
  registerSpeechCommands(program);
  registerMediaCommands(program);
  registerSceneCommands(program);
  registerDocCommands(program);
  registerModelsCommand(program);
  registerGuideCommand(program);
  registerHistoryCommands(program);
  registerCatalogCommands(program);
}
