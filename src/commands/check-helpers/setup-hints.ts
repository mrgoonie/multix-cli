/**
 * Setup instructions printed when provider keys are not configured.
 * Provider URLs match Python source check_setup.py.
 */

export const SETUP_HINTS = `
To configure multix, set at least one provider API key:

  Provider URLs:
    Gemini / AI Studio : https://aistudio.google.com/apikey
    OpenRouter         : https://openrouter.ai/settings/keys
    MiniMax            : https://platform.minimax.io/user-center/basic-information/interface-key

  Option A — user global config (recommended):
    echo 'GEMINI_API_KEY=your-key' >> ~/.multix/.env

  Option B — project .env:
    echo 'GEMINI_API_KEY=your-key' >> .env

  Option C — shell environment:
    export GEMINI_API_KEY=your-key
    export OPENROUTER_API_KEY=your-openrouter-key   # optional
    export MINIMAX_API_KEY=your-minimax-key          # optional

  After configuring, verify with:
    multix check
`.trim();

export const FFMPEG_HINT =
  "ffmpeg not found — media optimize/split/batch commands unavailable.\n" +
  "  Linux: sudo apt-get install ffmpeg\n" +
  "  macOS: brew install ffmpeg\n" +
  "  Windows: https://ffmpeg.org/download.html";

export const MAGICK_HINT =
  "ImageMagick (magick) not found — image optimization unavailable.\n" +
  "  Linux: sudo apt-get install imagemagick\n" +
  "  macOS: brew install imagemagick\n" +
  "  Windows: https://imagemagick.org/script/download.php";
