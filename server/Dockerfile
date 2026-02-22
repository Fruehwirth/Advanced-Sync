FROM node:20-alpine

RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

# Build context is Advanced-Sync/ (parent), so shared/ is accessible
COPY shared/ ./shared/

COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci

COPY server/tsconfig.json ./
COPY server/src/ ./src/

RUN npx tsc
RUN cp -r src/web-ui dist/server/src/web-ui
RUN npm prune --production

# node:20-alpine has a built-in 'node' user (UID 1000).
# Chown the built app so that user can read it at runtime.
RUN chown -R node:node /app

EXPOSE 8443
EXPOSE 21547/udp

VOLUME ["/data"]

ENV DATA_DIR=/data
ENV PORT=8443
ENV DISCOVERY_PORT=21547

USER node

CMD ["node", "dist/server/src/index.js"]
