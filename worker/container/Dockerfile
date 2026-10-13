# multix job container: the multix CLI built from this repository plus the job
# server (job-server.mjs) that runs one CLI job per container.
# Build context is the repository root (wrangler.jsonc: image_build_context ".."):
#   docker build -f worker/container/Dockerfile .
# Debian trixie: its imagemagick package is ImageMagick 7 (the CLI calls `magick`).
# No secrets are baked in: keys arrive per job in the job server's POST body.

FROM node:22-trixie-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

WORKDIR /job-server
COPY worker/container/package.json worker/container/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg imagemagick ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
RUN chmod +x /app/dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/multix

WORKDIR /job-server
COPY --from=build /job-server/node_modules ./node_modules
COPY worker/container/package.json worker/container/*.mjs ./

ENV NODE_ENV=production PORT=8080
# Each job gets its own mkdtemp directory under /tmp, removed when it ends.
USER node
WORKDIR /tmp
EXPOSE 8080
CMD ["node", "/job-server/job-server.mjs"]
