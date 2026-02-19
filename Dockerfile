FROM node:20-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@9

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/api packages/api
COPY packages/web packages/web
RUN pnpm -C packages/shared run build
RUN pnpm -C packages/web exec vite build
RUN pnpm -C packages/api run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/pnpm-workspace.yaml /app/package.json /app/pnpm-lock.yaml /app/
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/api /app/packages/api
COPY --from=build /app/packages/web/dist /app/packages/api/dist/web
EXPOSE 3001
CMD ["node", "/app/packages/api/dist/index.js"]
