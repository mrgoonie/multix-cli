export function GET() {
  return new Response(
    "## multix CLI documentation\n\n> Command reference for multix, an AI multimodal CLI for images, video, speech, music, documents, and media utilities.\n\n- [Overview](https://multix.zuey.me/index.md): Product purpose, install command, and a first generation workflow.\n- [Installation and configuration](https://multix.zuey.me/getting-started.md): Node and media-tool prerequisites, credentials, and setup validation.\n- [Command overview](https://multix.zuey.me/commands.md): Choose a provider or local workflow.\n- [Gemini commands](https://multix.zuey.me/commands/gemini.md): Analyze, transcribe, extract, image, video, and speech commands.\n- [OpenAI commands](https://multix.zuey.me/commands/openai.md): Image, image edit, TTS, and STT commands.\n- [Other providers](https://multix.zuey.me/commands/providers.md): MiniMax, OpenRouter, Leonardo, BytePlus, and ElevenLabs.\n- [Media and documents](https://multix.zuey.me/commands/media-and-documents.md): Document conversion and local media utilities.\n- [Environment reference](https://multix.zuey.me/reference/environment.md): Credentials, model overrides, and output location.\n- [AI agent guide](https://multix.zuey.me/reference/for-ai-agents.md): Safe discovery and reproducible command workflow.\n\nFor complete rendered content, use [llms-full.txt](https://multix.zuey.me/llms-full.txt).\n",
    {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    },
  );
}
