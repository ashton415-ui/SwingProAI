# Production image for the private Cloud Tasks analysis worker.
# Deterministic build: exact Node patch tag on a Debian-based slim image.
# This image starts the private task server directly and no other
# application entrypoint.
FROM node:22.23.1-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node . .

USER node

# Documents the Cloud Run ingress port contract. Cloud Run injects PORT at
# runtime; this is not a hard-coded environment value.
EXPOSE 8080

CMD ["node", "privateTaskServer.js"]
