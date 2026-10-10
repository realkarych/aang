FROM --platform=$BUILDPLATFORM golang:1.27 AS hook
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY packages/hook/go.mod packages/hook/go.sum ./
RUN go mod download
COPY packages/hook/cmd ./cmd
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/aang-hook ./cmd/aang-hook

FROM --platform=$BUILDPLATFORM node:26-slim AS build
WORKDIR /src
COPY package.json ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -b packages/aang
RUN pnpm --filter=@aang/web build
RUN pnpm --filter=@aang/aang --prod deploy /opt/aang/packages/aang && chmod 755 /opt/aang/packages/aang/dist/main.js
RUN mkdir /opt/aang/support && cp support/matrix.json /opt/aang/support/

FROM node:26-slim AS aang
RUN apt-get update && apt-get install --yes --no-install-recommends git tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/aang /opt/aang
COPY --from=hook /out/aang-hook /usr/local/bin/aang-hook
RUN ln -s /opt/aang/packages/aang/dist/main.js /usr/local/bin/aang \
  && hook="$(realpath /opt/aang/packages/aang/node_modules/@aang/hook)" \
  && mkdir -p "$hook/bin" \
  && ln -s /usr/local/bin/aang-hook "$hook/bin/aang-hook"
USER node
WORKDIR /home/node
ENTRYPOINT ["tini", "-s", "--", "docker-entrypoint.sh"]
CMD ["node"]
