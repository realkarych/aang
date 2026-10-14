# Docker image

The `Dockerfile` at the repository root builds the `catacomb` image on `node:26-slim` (ADR-0011, "Packaging"). It is the base layer for a solver image: in a derived image the user installs `claude` and/or `codex` and authorizes them inside the container, and the catacomb daemon and the solver run in the same container. The image is built from the monorepo sources and does not depend on npm publishing:

```sh
docker build --tag catacomb .
```

## Stages

| Stage | What it does |
| --- | --- |
| `hook` | builds `catacomb-hook` for the image platform (`TARGETOS`, `TARGETARCH`) by cross-compiling on the build platform: `go build -trimpath -ldflags="-s -w"` with `CGO_ENABLED=0`, like the binaries of the platform npm packages (P.1) |
| `build` | installs pnpm of the version from `packageManager`, runs `pnpm install --frozen-lockfile` and `tsc -b packages/catacomb`, then `pnpm deploy --prod` of the `catacomb` package into `/opt/catacomb/packages/catacomb`: the built internal packages, `store` migrations, `web` static assets, `zod` and `smol-toml`. It puts the support matrix `support/matrix.json` into `/opt/catacomb/support/matrix.json`: the `catacomb` command reads it at the path `../../../support/matrix.json` relative to its `dist/main.js`, so `/opt/catacomb` mirrors the repository layout |
| `catacomb` (final) | `node:26-slim` with `/opt/catacomb`, the `catacomb` and `catacomb-hook` commands in `/usr/local/bin`, `git` and `tini`. The `bin/catacomb-hook` link of the `@catacomb/hook` package inside `/opt/catacomb` points to `/usr/local/bin/catacomb-hook`: that is where `catacomb install` looks for the binary it copies into `<CATACOMB_HOME>/bin` |

In the final image:

- the user is `node`, the working directory is `/home/node`, `CATACOMB_HOME` defaults to `/home/node/.catacomb`;
- the entry point is `tini -s -- docker-entrypoint.sh`, the default command is `node`, as in `node:26-slim`.

`git` is needed by catacomb itself: through the Git common directory, a linked worktree of a watched repository located outside its directory is considered watched, check snapshots record HEAD and `git status`, and the observer context gets the worktree root. `node:26-slim` does not include it, and the solver CLIs do not bring it.

`tini` is needed because `catacomb start` spawns the daemon as a detached process, and it gets reparented to the container's PID 1. If PID 1 does not reap exited processes (`sleep`, a Node process, etc.), a stopped daemon remains a zombie, and `catacomb stop` cannot confirm the stop. `tini` reaps them with any container command, so `docker run --init` is not needed. With `--init` it works as a subreaper (`-s`) under Docker's init and emits no warnings.

## Solver image

The derived image switches to `root` to install the CLIs and switches back to `node`:

```dockerfile
FROM catacomb
USER root
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex
USER node
```

By default the daemon listens on `127.0.0.1` inside the container. Access to the UI is via an SSH tunnel or an explicit bind with the same token (ADR-0003), for example `catacomb start --bind 0.0.0.0` in a container started with `--publish 127.0.0.1:4280:4280`; the login link is provided by `catacomb open`.

## Verification

`pnpm test:docker` (tag `docker`, job `docker` in CI on Linux) after `pnpm build`:

1. builds the `catacomb` image, the `build` stage and the derived solver image `tools/docker-image/solver.Dockerfile`. The derived image adds to `catacomb` the fake `claude` and `codex` CLIs from `testkit` in `/usr/local/bin`, the player and sample scenarios;
2. checks the `catacomb` image: user `node` with and without `--init`, Node 26, `catacomb status` and running `catacomb-hook`;
3. in a container of the derived image, runs `catacomb start --bind 0.0.0.0` and publishes the API port on the host loopback. The fake CLIs answer `--version`. The API without a token answers 401, the `catacomb open` link via the published port yields a cookie. The player records the `claude-subagent` sample, and `GET /api/runs` returns its run: two agents, mode `files_only`. Then `catacomb stop` stops the daemon;
4. in a separate container, `catacomb install` installs the plugin of the fake `claude` and the hooks of the fake `codex`: `<CATACOMB_HOME>/bin` contains the same `catacomb-hook` as in the image, `hooks.json` contains the catacomb command string, and an event passed by the installed binary produces a run in the API;
5. in a separate container, the image's `catacomb-hook` writes a `SessionStart` event to the spool, and the daemon shows the run of this session in `hooks_only` mode;
6. in a separate container, before starting the daemon, creates a Git repository, its linked worktree outside the repository directory and an unwatched directory; the config watches only the repository directory (`watch.all: false`). `catacomb-hook` passes session starts in the worktree and in the unwatched directory, and the API returns a run only for the worktree session: the Git common directory makes it count as watched.

Inside the container, the player and the installation of the fake CLIs are run by this package's `dist/main.js` (`install-clis`, `play`). It is not part of the `catacomb` image. The package does not collect `c8` coverage (`.c8rc.json`): its code runs only inside the container.
