FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts/bundle-mcp-runtime.mjs scripts/clean-dist.mjs ./scripts/
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node web ./web
COPY --chown=node:node packs ./packs
COPY --chown=node:node seed ./seed
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./

USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/readyz',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/cli.js", "registry", "serve", "--host", "0.0.0.0", "--port", "8787"]
