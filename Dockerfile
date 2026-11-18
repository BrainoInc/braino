# syntax=docker/dockerfile:1

FROM rust:1.100-bookworm AS plugin-build

RUN rustup target add wasm32-wasip2
WORKDIR /source
COPY packages/plugin-runtime/wit packages/plugin-runtime/wit
COPY plugins/ollama-chat plugins/ollama-chat
COPY plugins/ollama-embedding plugins/ollama-embedding
COPY plugins/openai-chat plugins/openai-chat
COPY plugins/openai-embedding plugins/openai-embedding
COPY plugins/slack plugins/slack
COPY plugins/github plugins/github
COPY plugins/resend plugins/resend
RUN cargo build --locked --release --target wasm32-wasip2 \
  --manifest-path plugins/ollama-chat/Cargo.toml
RUN cargo build --locked --release --target wasm32-wasip2 \
  --manifest-path plugins/ollama-embedding/Cargo.toml
RUN cargo build --locked --release --target wasm32-wasip2 \
  --manifest-path plugins/openai-chat/Cargo.toml
RUN cargo build --locked --release --target wasm32-wasip2 \
  --manifest-path plugins/openai-embedding/Cargo.toml
RUN cargo build --locked --release --target wasm32-wasip2 \
  --manifest-path plugins/slack/Cargo.toml
RUN cargo build --locked --release --target wasm32-wasip2 \
  --manifest-path plugins/github/Cargo.toml
RUN cargo build --locked --release --target wasm32-wasip2 \
  --manifest-path plugins/resend/Cargo.toml

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/connector-plugins/package.json packages/connector-plugins/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/host/package.json packages/host/package.json
COPY packages/index/package.json packages/index/package.json
COPY packages/plugin-runtime/package.json packages/plugin-runtime/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

COPY . .
ARG DOCO_VERSION=local
ENV DOCO_VERSION=$DOCO_VERSION
RUN pnpm run build:packages && pnpm --filter @doco/web build
RUN pnpm --filter @doco/web deploy --prod --legacy /opt/doco

FROM node:22-bookworm-slim AS runtime

ARG DOCO_VERSION=local
ENV DOCO_VERSION=$DOCO_VERSION
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /opt/doco ./
COPY --from=build --chown=node:node /source/runtime ./runtime
COPY --from=plugin-build --chown=node:node \
  /source/plugins/ollama-chat/target/wasm32-wasip2/release/braino_ollama_chat.wasm \
  /app/plugins/braino_ollama_chat.wasm
COPY --from=plugin-build --chown=node:node \
  /source/plugins/ollama-chat/manifest.json \
  /app/plugins/braino_ollama_chat.manifest.json
COPY --from=plugin-build --chown=node:node \
  /source/plugins/ollama-embedding/target/wasm32-wasip2/release/braino_ollama_embedding.wasm \
  /app/plugins/braino_ollama_embedding.wasm
COPY --from=plugin-build --chown=node:node \
  /source/plugins/ollama-embedding/manifest.json \
  /app/plugins/braino_ollama_embedding.manifest.json
COPY --from=plugin-build --chown=node:node \
  /source/plugins/openai-chat/target/wasm32-wasip2/release/braino_openai_chat.wasm \
  /app/plugins/braino_openai_chat.wasm
COPY --from=plugin-build --chown=node:node \
  /source/plugins/openai-chat/manifest.json \
  /app/plugins/braino_openai_chat.manifest.json
COPY --from=plugin-build --chown=node:node \
  /source/plugins/openai-embedding/target/wasm32-wasip2/release/braino_openai_embedding.wasm \
  /app/plugins/braino_openai_embedding.wasm
COPY --from=plugin-build --chown=node:node \
  /source/plugins/openai-embedding/manifest.json \
  /app/plugins/braino_openai_embedding.manifest.json
COPY --from=plugin-build --chown=node:node \
  /source/plugins/slack/target/wasm32-wasip2/release/braino_slack.wasm \
  /app/plugins/braino_slack.wasm
COPY --from=plugin-build --chown=node:node \
  /source/plugins/slack/manifest.json \
  /app/plugins/braino_slack.manifest.json
COPY --from=plugin-build --chown=node:node \
  /source/plugins/github/target/wasm32-wasip2/release/braino_github.wasm \
  /app/plugins/braino_github.wasm
COPY --from=plugin-build --chown=node:node \
  /source/plugins/github/manifest.json \
  /app/plugins/braino_github.manifest.json
COPY --from=plugin-build --chown=node:node \
  /source/plugins/resend/target/wasm32-wasip2/release/braino_resend.wasm \
  /app/plugins/braino_resend.wasm
COPY --from=plugin-build --chown=node:node \
  /source/plugins/resend/manifest.json \
  /app/plugins/braino_resend.manifest.json

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=10s --start-period=30s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm", "start"]
