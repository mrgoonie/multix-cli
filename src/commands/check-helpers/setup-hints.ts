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
    Leonardo.Ai        : https://app.leonardo.ai/settings/api-keys
    BytePlus           : https://console.byteplus.com/auth/api-keys
    fal.ai             : https://fal.ai/dashboard/keys
    Atlas Cloud        : https://www.atlascloud.ai/console/api-keys
    Replicate          : https://replicate.com/account/api-tokens
    Runway             : https://dev.runwayml.com/
    HeyGen             : https://app.heygen.com/developers/api

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
