# Transmat API. Node 22 for the built-in node:sqlite — no native modules,
# so this builds on any architecture without a toolchain.
FROM node:22-alpine

WORKDIR /app

# Dependencies first so a code change does not re-install them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# DATA_DIR holds the SQLite file and, on the local storage driver, the blobs.
# Mount a volume here or everything vanishes on redeploy.
ENV DATA_DIR=/data \
    PORT=8787 \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8787

# No shell wrapper: node is PID 1 and gets SIGTERM directly, so the graceful
# shutdown path (drain SSE clients, close the db) actually runs.
CMD ["node", "src/index.js"]
