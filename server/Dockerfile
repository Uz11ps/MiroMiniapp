FROM node:20-slim AS base

FROM base AS build
WORKDIR /app/server
# Server deps only
COPY server/package.json ./package.json
RUN npm i --legacy-peer-deps
# tsconfig base from repo root
COPY tsconfig.base.json /app/tsconfig.base.json
# Prisma + ts + src
COPY server/prisma ./prisma
COPY server/tsconfig.json ./tsconfig.json
COPY server/src ./src
COPY server/scripts ./scripts
RUN npx prisma generate && npm run build

FROM node:20-slim AS runner
WORKDIR /app/server
ENV NODE_ENV=production
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/prisma ./prisma
COPY --from=build /app/server/scripts ./scripts
EXPOSE 4000
CMD ["node", "dist/index.js"]
