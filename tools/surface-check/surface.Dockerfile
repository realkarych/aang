ARG CATACOMB_IMAGE=catacomb
ARG BUILD_IMAGE=catacomb:build

FROM ${BUILD_IMAGE} AS surface-check
RUN pnpm exec tsc -b tools/surface-check
RUN pnpm --filter=@catacomb/surface-check --prod deploy /opt/surface-check && cp -R support /opt/surface-check/support

FROM ${CATACOMB_IMAGE}
ARG CATACOMB_CLAUDE_CODE_VERSION
ARG CATACOMB_CODEX_VERSION
ARG CATACOMB_CLAUDE_AGENT_SDK_VERSION
ARG CATACOMB_CODEX_SDK_VERSION
USER root
RUN apt-get update && apt-get install --yes --no-install-recommends expect && rm -rf /var/lib/apt/lists/*
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code \
  "@anthropic-ai/claude-code@${CATACOMB_CLAUDE_CODE_VERSION}" "@openai/codex@${CATACOMB_CODEX_VERSION}"
RUN npm install --prefix /opt/sdk \
  "@anthropic-ai/claude-agent-sdk@${CATACOMB_CLAUDE_AGENT_SDK_VERSION}" "@openai/codex-sdk@${CATACOMB_CODEX_SDK_VERSION}"
COPY --from=surface-check /opt/surface-check /opt/surface-check
USER node
ENV CATACOMB_RECORD_CLAUDE_SDK=/opt/sdk/node_modules/@anthropic-ai/claude-agent-sdk
ENV CATACOMB_RECORD_CODEX_SDK=/opt/sdk/node_modules/@openai/codex-sdk
