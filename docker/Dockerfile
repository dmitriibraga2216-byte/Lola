# Multi-stage: сборка Nuxt → минимальный рантайм с ffmpeg для воркера (docs/26 §26.4)
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
ENV COREPACK_INTEGRITY_KEYS=0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG APP_VERSION=dev
ARG APP_COMMIT=local
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache ffmpeg tini curl
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
ARG APP_VERSION=dev
ARG APP_COMMIT=local
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT
COPY --from=build /app/.output ./.output
# Миграции и сид идут через tsx из исходников (только server/db и shared)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server/db ./server/db
COPY --from=build /app/server/assets ./server/assets
COPY --from=build /app/shared ./shared
COPY --from=build /app/drizzle.config.ts ./
RUN addgroup -S lola && adduser -S lola -G lola && chown -R lola:lola /app
USER lola
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -sf http://localhost:3000/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]
