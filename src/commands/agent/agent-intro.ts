/**
 * The orientation block an agent sees first: `multix -V` prints it under the
 * version number, and `multix --help` ends with it. Kept short and stable; the
 * full protocol is `multix guide` and the long form is the skills.
 */

export const AGENT_INTRO = `
multix: one CLI for AI media. It generates and edits images, video, speech, music and 3D,
transcribes audio and converts documents, across OpenAI, Gemini, MiniMax, OpenRouter, Leonardo,
BytePlus, ElevenLabs, Fish, fal.ai, Atlas Cloud, Replicate, Runway, HeyGen, TopView and more, plus
local ffmpeg/ImageMagick tools. Provider keys come from the environment or ~/.multix/.env.

Agents, start here:
  multix guide                          the agent protocol: discover, --dry-run, --json, errors, history
  multix models --task <task> --ready   which command and model serve a task, and which keys are set
  multix check                          tools and provider keys that are missing
  multix skills                         the agent skills shipped with multix (usage, best practices,
                                        troubleshooting); \`multix skills multix\` prints the main one
Before a paid run: add --dry-run or --estimate. Read results with --json.
Remote use: the multix MCP server serves the same skills (skills/list, resources).
`;
