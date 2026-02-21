FROM node:20-alpine

RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

# shared/ and server/ are siblings — when deployed, both are in the same folder
COPY shared/ ./shared/

COPY package.json package-lock.json ./server/
WORKDIR /app/server
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc
RUN cp -r src/web-ui dist/server/src/web-ui
RUN npm prune --production

EXPOSE 8443
EXPOSE 21547/udp

VOLUME ["/data"]

ENV DATA_DIR=/data
ENV PORT=8443
ENV DISCOVERY_PORT=21547

CMD ["node", "dist/server/src/index.js"]
