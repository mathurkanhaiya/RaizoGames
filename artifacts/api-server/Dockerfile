# ─── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config files needed for pnpm install
COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY package.json ./
COPY tsconfig.json ./
COPY tsconfig.base.json ./
COPY .npmrc ./

# Copy lib package manifests (workspace deps)
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/db/package.json lib/db/

# Copy api-server package manifest
COPY artifacts/api-server/package.json artifacts/api-server/

# Install all deps (including devDeps for build)
RUN pnpm install --frozen-lockfile --filter @workspace/api-server...

# Copy source files
COPY lib/api-zod/src lib/api-zod/src
COPY lib/db/src lib/db/src
COPY artifacts/api-server/src artifacts/api-server/src
COPY artifacts/api-server/build.mjs artifacts/api-server/build.mjs
COPY artifacts/api-server/tsconfig.json artifacts/api-server/tsconfig.json

# Build — esbuild bundles everything into dist/index.mjs (self-contained)
RUN pnpm --filter @workspace/api-server run build

# ─── Stage 2: Production image ────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# esbuild bundles all JS deps; dist is fully self-contained
COPY --from=builder /app/artifacts/api-server/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
