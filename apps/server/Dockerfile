# The bundle is built on the developer's machine (pnpm build); this image only runs it.
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY dist ./dist
COPY migrations ./migrations
# uid 1000, the same as the ubuntu user that owns /srv/echomind/certs on the server.
USER node
EXPOSE 8443
CMD ["node", "--enable-source-maps", "dist/main.js"]
