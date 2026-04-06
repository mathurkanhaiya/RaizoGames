FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY tsconfig.json ./

COPY artifacts/api-server/package.json artifacts/api-server/
COPY shared/ shared/

RUN pnpm install --frozen-lockfile --filter @workspace/api-server...

COPY artifacts/api-server/ artifacts/api-server/

RUN pnpm --filter @workspace/api-server run build

FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY tsconfig.json ./

COPY artifacts/api-server/package.json artifacts/api-server/
COPY shared/ shared/

RUN pnpm install --frozen-lockfile --filter @workspace/api-server... --prod

COPY --from=builder /app/artifacts/api-server/dist artifacts/api-server/dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "artifacts/api-server/dist/index.js"]
