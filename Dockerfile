FROM --platform=$BUILDPLATFORM golang:1.27 AS hook
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY packages/hook/go.mod packages/hook/go.sum ./
RUN go mod download
COPY packages/hook/cmd ./cmd
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/catacomb-hook ./cmd/catacomb-hook

FROM --platform=$BUILDPLATFORM node:26-slim AS build
WORKDIR /src
COPY package.json ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -b packages/catacomb
RUN pnpm --filter=@catacomb/web build
RUN pnpm --filter=@catacomb/catacomb --prod deploy /opt/catacomb/packages/catacomb && chmod 755 /opt/catacomb/packages/catacomb/dist/main.js
RUN mkdir /opt/catacomb/support && cp support/matrix.json /opt/catacomb/support/

FROM node:26-slim AS catacomb
RUN apt-get update && apt-get install --yes --no-install-recommends git tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/catacomb /opt/catacomb
COPY --from=hook /out/catacomb-hook /usr/local/bin/catacomb-hook
RUN ln -s /opt/catacomb/packages/catacomb/dist/main.js /usr/local/bin/catacomb \
  && hook="$(realpath /opt/catacomb/packages/catacomb/node_modules/@catacomb/hook)" \
  && mkdir -p "$hook/bin" \
  && ln -s /usr/local/bin/catacomb-hook "$hook/bin/catacomb-hook"
USER node
WORKDIR /home/node
ENTRYPOINT ["tini", "-s", "--", "docker-entrypoint.sh"]
CMD ["node"]
