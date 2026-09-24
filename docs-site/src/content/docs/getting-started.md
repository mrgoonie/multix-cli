---
title: Install and configure
description: Install multix, configure provider credentials, and verify the CLI before running media workflows.
---

## Install

Use Node.js 20 or newer. Install globally or run the package with `npx`.

```bash
npm install -g @mrgoonie/multix
# or
npx -p @mrgoonie/multix multix --help
```

For media processing, install `ffmpeg` and ImageMagick 7+ (`magick`) on your
`PATH`.

## Add a provider key

Create `.env` in the current project, or use `~/.multix/.env`. Environment
variables override either file.

```bash
GEMINI_API_KEY=...
# or OPENAI_API_KEY, OPENROUTER_API_KEY, MINIMAX_API_KEY,
# LEONARDO_API_KEY, BYTEPLUS_API_KEY, ELEVENLABS_API_KEY
```

Never commit `.env` files. Run the setup check before generating media.

```bash
multix check
multix check --verbose
```

## Keep multix up to date

```bash
multix update --check
multix update
```

`multix update` detects how the CLI was installed (npm, pnpm, yarn, or bun
global) and runs the matching install command. `--check` only compares
versions; `--tag <tag>` installs a specific dist-tag; `--dry-run` prints the
command instead of running it. See [command overview](/commands/) for the
full flag reference.
