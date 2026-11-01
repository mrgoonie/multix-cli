# multix-server: the public Multix MCP server, dashboard and REST API as one
# Node.js process (no Cloudflare runtime). Build context is the repository root:
#   docker build -f worker/server/Dockerfile -t multix-server:dev .
# State lives in one SQLite file under /data (mount a persistent volume).
# No secrets are baked in: pass them as environment variables at run time.
# This is not the internal job image (worker/container/Dockerfile), which must
# never be exposed to the Internet.

# node:sqlite needs Node >= 22.13; keep the major in step with the undici
# version pinned in worker/package.json (it shares the runtime's fetch).
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
# The Worker imports runtime-neutral clients from the CLI source (src/**).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY worker/package.json worker/package-lock.json ./worker/
RUN npm ci --prefix worker --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY skill ./skill
COPY worker ./worker
ARG MULTIX_VERSION=dev
RUN cd worker && npm run skills && node scripts/build-server.mjs --version "${MULTIX_VERSION}"

FROM ${NODE_IMAGE}
ARG MULTIX_VERSION=dev
LABEL org.opencontainers.image.title="multix-server" \
      org.opencontainers.image.description="Self-hosted Multix remote MCP server, dashboard and REST API" \
      org.opencontainers.image.source="https://github.com/mrgoonie/multix-cli" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${MULTIX_VERSION}"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MULTIX_DATA_DIR=/data
WORKDIR /app
COPY --from=build /src/worker/dist-server/ ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# exec form: node is PID 1 and receives SIGTERM directly (graceful shutdown).
CMD ["node", "--disable-warning=ExperimentalWarning", "--enable-source-maps", "multix-server.mjs"]
