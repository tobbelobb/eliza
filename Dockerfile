################  1) Build  ################
FROM oven/bun:1.2.5-slim AS builder
WORKDIR /app

# (Keep build tools here only)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git python3 && \
    rm -rf /var/lib/apt/lists/*

COPY package.json bun.lockb tsconfig.json turbo.json lerna.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile      # dev deps OK in builder
RUN bun run build                      # writes packages/*/dist

################  2) Runtime  ################
FROM oven/bun:1.2.5-slim  # 48 MB base

WORKDIR /app
ENV NODE_ENV=production

# Runtime needs only curl + ffmpeg? install them, nothing else:
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# production deps only (no TypeScript, etc.)
COPY package.json bun.lockb ./
RUN bun install --production --no-cache

# copy the built artefacts, not full source tree
COPY --from=builder /app/packages/*/dist ./packages/
COPY --from=builder /app/scripts ./scripts

# CLI (adds just a few MB)
RUN bun install -g @elizaos/cli

EXPOSE 3000 50000-50100/udp
CMD ["elizaos", "start"]
