ARG AANG_IMAGE=aang
ARG BUILD_IMAGE=aang:build

FROM ${BUILD_IMAGE} AS surface-check
RUN pnpm exec tsc -b tools/surface-check
RUN pnpm --filter=@aang/surface-check --prod deploy /opt/surface-check && cp -R support /opt/surface-check/support

FROM ${AANG_IMAGE}
ARG AANG_CLAUDE_CODE_VERSION
ARG AANG_CODEX_VERSION
ARG AANG_CLAUDE_AGENT_SDK_VERSION
ARG AANG_CODEX_SDK_VERSION
USER root
RUN apt-get update && apt-get install --yes --no-install-recommends expect && rm -rf /var/lib/apt/lists/*
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code \
  "@anthropic-ai/claude-code@${AANG_CLAUDE_CODE_VERSION}" "@openai/codex@${AANG_CODEX_VERSION}"
RUN npm install --prefix /opt/sdk \
  "@anthropic-ai/claude-agent-sdk@${AANG_CLAUDE_AGENT_SDK_VERSION}" "@openai/codex-sdk@${AANG_CODEX_SDK_VERSION}"
COPY --from=surface-check /opt/surface-check /opt/surface-check
USER node
ENV AANG_RECORD_CLAUDE_SDK=/opt/sdk/node_modules/@anthropic-ai/claude-agent-sdk
ENV AANG_RECORD_CODEX_SDK=/opt/sdk/node_modules/@openai/codex-sdk
