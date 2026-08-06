# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Dependencies first so this layer caches and only re-runs when the manifests
# change. npm install (not npm ci) per the Beachhead rules.
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-resolve to production dependencies only, so the runtime image does not
# carry TypeScript, vitest and the type packages.
RUN npm install --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Run unprivileged. node:alpine already ships a `node` user (uid 1000).
RUN chown node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

EXPOSE 3001

# No npm wrapper in the entrypoint: npm would sit between the init system and
# node, swallowing SIGTERM. The process must receive it directly for the
# graceful shutdown in src/index.ts to run during a Beachhead blue/green swap.
CMD ["node", "dist/index.js"]
