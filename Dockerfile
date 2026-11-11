# syntax=docker/dockerfile:1
# Kanban de Vagas em UM container: a API (que também serve o web buildado) e o worker, iniciados por
# scripts/start-prod.mjs. O banco é um Postgres externo, informado em DATABASE_URL.
#
#   docker build -t kanban-vagas .
#   docker run --rm -p 8080:8080 -e DATABASE_URL=postgres://... kanban-vagas
#
# ATENÇÃO: o app ainda não tem login. Não publique este container em uma URL pública.

ARG NODE_IMAGE=node:24.15.0-bookworm-slim

# --- base: pnpm (mesma versão usada no repo) + manifests, para o cache de dependências --------------
FROM ${NODE_IMAGE} AS base
ENV CI=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    # O pacote playwright (conector Indeed) nunca deve baixar navegadores para a imagem.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/connectors/package.json packages/connectors/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

# --- build: todas as dependências (inclusive dev) só para gerar apps/web/dist -------------------------
FROM base AS build
RUN --mount=type=cache,id=kv-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @kv/web build

# --- prod-deps: só o que API e worker precisam em runtime (sem web, sem devDependencies) -------------
FROM base AS prod-deps
RUN --mount=type=cache,id=kv-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@kv/api..." --filter "@kv/worker..."

# --- runtime ------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    # Padrão para `docker run`; no Railway a plataforma injeta a PORT dela.
    PORT=8080
WORKDIR /app
# node_modules de produção (raiz + links de cada pacote) e os package.json.
COPY --from=prod-deps /app ./
# API, worker e pacotes rodam direto do TypeScript, com tsx: não há passo de build para eles.
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY scripts/start-prod.mjs scripts/
COPY --from=build /app/apps/web/dist apps/web/dist
# Usuário sem privilégios (uid 1000, já existe na imagem oficial); o app não grava nada em disco.
USER node
EXPOSE 8080
CMD ["node", "scripts/start-prod.mjs"]
