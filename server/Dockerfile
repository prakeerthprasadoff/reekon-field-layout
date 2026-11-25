# Sync server image. Build context is the repo root (the server imports ../shared).
FROM node:24-alpine
WORKDIR /srv
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci --workspace @field/server --include-workspace-root=false --ignore-scripts
COPY shared/src shared/src
COPY server/src server/src
ENV PORT=8787 DATA_DIR=/data NODE_NO_WARNINGS=1
EXPOSE 8787
VOLUME /data
WORKDIR /srv/server
CMD ["npx", "tsx", "src/index.ts"]
