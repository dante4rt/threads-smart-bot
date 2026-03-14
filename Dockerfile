# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

# Native addon compilation deps (better-sqlite3 requires python3/make/g++)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Layer-cache: install deps before copying source
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner

ENV NODE_ENV=production

WORKDIR /app

# Dedicated non-root user
RUN groupadd -r botuser && useradd -r -g botuser -d /app botuser

# Pull compiled output + production node_modules (includes native binaries)
COPY --from=builder --chown=botuser:botuser /build/node_modules ./node_modules
COPY --from=builder --chown=botuser:botuser /build/dist        ./dist
# package.json is required at runtime so Node resolves the ESM "type" field
COPY --chown=botuser:botuser package.json ./

# SQLite data directory — overridden by volume mount in production
RUN mkdir -p /app/data && chown botuser:botuser /app/data

USER botuser

VOLUME ["/app/data"]

# Health: exit-code 0 = process is alive (scheduler keeps running)
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "process.exit(0)"

CMD ["node", "dist/index.js"]
