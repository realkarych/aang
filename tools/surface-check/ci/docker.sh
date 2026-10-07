#!/bin/bash
set -euo pipefail

out="$(mkdir -p "$1" && cd "$1" && pwd)"
tag="aang-surface-$$"
name="$tag"
check="node tools/surface-check/dist/main.js"
port=4280
other=4380
work="$(mktemp -d)"

cleanup() {
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker image rm --force "$tag" "$tag-aang" "$tag-build" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker build --progress=plain --tag "$tag-aang" .
docker build --progress=plain --tag "$tag-build" --target build .
docker build --progress=plain --tag "$tag" --file tools/surface-check/surface.Dockerfile \
  --build-arg AANG_IMAGE="$tag-aang" --build-arg BUILD_IMAGE="$tag-build" \
  --build-arg AANG_CLAUDE_CODE_VERSION="$AANG_CLAUDE_CODE_VERSION" \
  --build-arg AANG_CODEX_VERSION="$AANG_CODEX_VERSION" \
  --build-arg AANG_CLAUDE_AGENT_SDK_VERSION="$AANG_CLAUDE_AGENT_SDK_VERSION" \
  --build-arg AANG_CODEX_SDK_VERSION="$AANG_CODEX_SDK_VERSION" .

docker run --detach --name "$name" \
  --publish "127.0.0.1:$port:$port" --publish "127.0.0.1:$other:$port" \
  "$tag" sleep infinity

status=0
docker exec "$name" node /opt/surface-check/dist/main.js run \
  --placement docker --aang aang --hook /usr/local/bin/aang-hook --support /opt/surface-check/support \
  --bind 0.0.0.0 --port "$port" --keep-daemon /tmp/surface-kept.json --require "${AANG_SURFACE_REQUIRE:-}" \
  --out /tmp/surface-check || status=$?
docker cp "$name:/tmp/surface-check/." "$out/"
docker cp "$name:/tmp/surface-kept.json" "$work/kept.json" 2>/dev/null || true

kept() {
  if [ -f "$work/kept.json" ]; then
    node -e 'process.stdout.write(require(process.argv[1])[process.argv[2]])' "$work/kept.json" "$1"
  fi
}
open_link() {
  docker exec --env AANG_HOME="$(kept aang_home)" --env HOME="$(kept home)" "$name" aang open
}

if [ -n "$(kept aang_home)" ]; then
  $check access --link "$(open_link)" --origin "http://127.0.0.1:$port" --into "$out/report.json" || status=1
  $check access --link "$(open_link)" --origin "http://127.0.0.1:$other" --expect-write 403 --out "$out/access-other-port.json" || status=1
  if [ "$(uname -s)" = Linux ]; then
    address="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")"
    $check access --link "$(open_link)" --origin "http://$address:$port" --expect-write 403 --out "$out/access-bind-address.json" || status=1
  fi
else
  status=1
fi
exit "$status"
