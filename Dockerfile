FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3780 DATABASE_PATH=/app/data/company-ai-hub.db SESSION_COOKIE_SECURE=true
WORKDIR /app
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public
USER node
EXPOSE 3780
CMD ["node", "dist/src/server.js"]
