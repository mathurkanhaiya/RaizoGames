# ─── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Pin pnpm to a specific version (matches lockfileVersion 9.0)
RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace config files
COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY tsconfig.json ./
COPY tsconfig.base.json ./
COPY .npmrc ./

# Copy root package.json but skip its preinstall script (it blocks non-interactive envs)
COPY package.json ./
RUN pnpm pkg delete scripts.preinstall

# Copy lib workspace package manifests
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/db/package.json lib/db/

# Copy api-server package manifest
COPY artifacts/api-server/package.json artifacts/api-server/

# Install all deps (dev + prod needed for build)
RUN pnpm install --no-frozen-lockfile --filter @workspace/api-server...

# Copy source
COPY lib/api-zod/src lib/api-zod/src
COPY lib/db/src lib/db/src
COPY artifacts/api-server/src artifacts/api-server/src
COPY artifacts/api-server/build.mjs artifacts/api-server/build.mjs
COPY artifacts/api-server/tsconfig.json artifacts/api-server/tsconfig.json

# Build — esbuild bundles everything into a self-contained dist/index.mjs
RUN pnpm --filter @workspace/api-server run build

# ─── Stage 2: Minimal production image ────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# dist is fully self-contained — no node_modules needed at runtime
COPY --from=builder /app/artifacts/api-server/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
