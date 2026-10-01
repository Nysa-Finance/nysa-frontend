# Nysa frontend + API for the VPS deploy (see docker-compose.yml, README "VPS deploy").
# VITE_SOLANA_RPC is baked into the browser bundle at build time, so it is a build arg.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY . .
ARG VITE_SOLANA_RPC
RUN npm test && npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY --from=build /app/package.json /app/server.js ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/dist ./dist
COPY --from=build /app/api ./api
COPY --from=build /app/src ./src
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
