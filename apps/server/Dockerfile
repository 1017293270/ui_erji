# Built on echomind-server from its git checkout, with the repo root as the context
# (compose.yaml: context ../src, dockerfile apps/server/Dockerfile).
FROM node:24-alpine AS build
RUN npm install -g --no-fund --no-audit pnpm@11.18.0
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=echomind-pnpm,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter @echomind/server...
ARG ECHOMIND_VERSION
RUN ECHOMIND_VERSION=$ECHOMIND_VERSION pnpm --filter @echomind/server build

# The bundle carries its dependencies, so the image needs only Node, dist and the migrations.
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/migrations ./migrations
# uid 1000, the same as the ubuntu user that owns /srv/echomind/certs on the server.
USER node
EXPOSE 8443
CMD ["node", "--enable-source-maps", "dist/main.js"]
