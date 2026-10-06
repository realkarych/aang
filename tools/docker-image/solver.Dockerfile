ARG AANG_IMAGE=aang
ARG BUILD_IMAGE=aang:build

FROM ${BUILD_IMAGE} AS fake-solver
RUN pnpm exec tsc -b tools/docker-image
RUN pnpm --filter=@aang/docker-image --prod deploy /opt/fake-solver

FROM ${AANG_IMAGE}
USER root
COPY --from=fake-solver /opt/fake-solver /opt/fake-solver
COPY packages/testkit/sample-scenarios /opt/samples/packages/testkit/sample-scenarios
COPY docs/research/samples /opt/samples/docs/research/samples
RUN node /opt/fake-solver/dist/main.js install-clis /opt/fake-cli /usr/local/bin && chown -R node:node /opt/fake-cli
USER node
