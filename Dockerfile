# syntax=docker/dockerfile:1.7
# One build for every service. Targets: `app` (api, worker, migrate) and `web`.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @dosly/shared build && pnpm --filter @dosly/db build && pnpm --filter @dosly/core build \
 && pnpm --filter @dosly/api build && pnpm --filter @dosly/worker build && pnpm --filter @dosly/web build

FROM base AS app
ENV NODE_ENV=production
COPY --from=build /app /app
# Named volumes copy this ownership on first mount, so the API can write uploads as the node user.
RUN mkdir -p /data/media && chown node:node /data/media
USER node
CMD ["node", "apps/api/dist/server.js"]

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
CMD ["node", "apps/web/server.js"]
