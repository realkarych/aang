#!/bin/bash
set -euo pipefail

out="$(mkdir -p "$1" && cd "$1" && pwd)"
work="$(mktemp -d)"
check="node tools/surface-check/dist/main.js"
image_url="${AANG_VM_IMAGE:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}"
port=4280
other=4380
ssh_port=2222
key="$work/key"
common=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 -i "$key")
ssh_options=("${common[@]}" -p "$ssh_port")
scp_options=("${common[@]}" -P "$ssh_port")
tunnels=()

cleanup() {
  for pid in "${tunnels[@]}"; do kill "$pid" 2>/dev/null || true; done
  if [ -f "$work/vm.pid" ]; then kill "$(cat "$work/vm.pid")" 2>/dev/null || true; fi
}
trap cleanup EXIT

vm() {
  ssh "${ssh_options[@]}" aang@127.0.0.1 "$@"
}

bundle="$work/bundle"
mkdir -p "$bundle/opt/aang/support" "$bundle/opt/aang-hook"
pnpm --filter=@aang/aang --prod deploy "$bundle/opt/aang/packages/aang"
cp support/matrix.json "$bundle/opt/aang/support/"
pnpm --filter=@aang/surface-check --prod deploy "$bundle/opt/surface-check"
cp -R support "$bundle/opt/surface-check/support"
cp packages/hook/bin/aang-hook "$bundle/opt/aang-hook/aang-hook"
tar -C "$bundle" -czf "$work/bundle.tgz" opt

curl -fsSL --retry 3 -o "$work/base.img" "$image_url"
qemu-img create -q -f qcow2 -F qcow2 -b "$work/base.img" "$work/vm.qcow2" 20G
ssh-keygen -q -t ed25519 -N '' -C aang-surface-check -f "$key"
cat > "$work/user-data" <<CLOUD
#cloud-config
users:
  - name: aang
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - $(cat "$key.pub")
CLOUD
cloud-localds "$work/seed.img" "$work/user-data"
qemu-system-x86_64 -enable-kvm -cpu host -m 8192 -smp 3 \
  -drive "file=$work/vm.qcow2,if=virtio" -drive "file=$work/seed.img,if=virtio,format=raw" \
  -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:$ssh_port-:22" \
  -display none -serial "file:$out/serial.log" -daemonize -pidfile "$work/vm.pid"

deadline=$((SECONDS + 300))
until vm true 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then echo "the VM did not answer over SSH" >&2; exit 1; fi
  sleep 5
done
vm cloud-init status --wait >/dev/null || true

node_version="$(node --version)"
scp "${scp_options[@]}" "$work/bundle.tgz" aang@127.0.0.1:/tmp/bundle.tgz
vm bash -euo pipefail -s -- "$node_version" "$AANG_CLAUDE_CODE_VERSION" "$AANG_CODEX_VERSION" \
  "$AANG_CLAUDE_AGENT_SDK_VERSION" "$AANG_CODEX_SDK_VERSION" <<'SETUP'
node_version="$1"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq expect git libatomic1 >/dev/null
curl -fsSL --retry 3 "https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz" | sudo tar -xJ -C /usr/local --strip-components=1
sudo tar -xzf /tmp/bundle.tgz -C /
sudo install -m 0755 /opt/aang-hook/aang-hook /usr/local/bin/aang-hook
sudo chmod 755 /opt/aang/packages/aang/dist/main.js
sudo ln -sf /opt/aang/packages/aang/dist/main.js /usr/local/bin/aang
hook="$(realpath /opt/aang/packages/aang/node_modules/@aang/hook)"
sudo mkdir -p "$hook/bin"
sudo ln -sf /usr/local/bin/aang-hook "$hook/bin/aang-hook"
sudo npm install --global --allow-scripts=@anthropic-ai/claude-code "@anthropic-ai/claude-code@$2" "@openai/codex@$3" >/dev/null
sudo npm install --prefix /opt/sdk "@anthropic-ai/claude-agent-sdk@$4" "@openai/codex-sdk@$5" >/dev/null
SETUP

status=0
run_check() {
  local name="$1"
  shift
  vm env AANG_RECORD_CLAUDE_SDK=/opt/sdk/node_modules/@anthropic-ai/claude-agent-sdk \
    AANG_RECORD_CODEX_SDK=/opt/sdk/node_modules/@openai/codex-sdk \
    node /opt/surface-check/dist/main.js run --aang aang --hook /usr/local/bin/aang-hook \
    --support /opt/surface-check/support --port "$port" --keep-daemon "/tmp/$name-kept.json" --out "/tmp/$name" "$@" || status=$?
  mkdir -p "$out/$name"
  vm tar -C "/tmp/$name" -cf - . | tar -C "$out/$name" -xf -
  vm cat "/tmp/$name-kept.json" > "$work/$name-kept.json" 2>/dev/null || rm -f "$work/$name-kept.json"
}
kept() {
  if [ -f "$work/$1-kept.json" ]; then
    node -e 'process.stdout.write(require(process.argv[1])[process.argv[2]])' "$work/$1-kept.json" "$2"
  fi
}
open_link() {
  vm "AANG_HOME='$(kept "$1" aang_home)' HOME='$(kept "$1" home)' aang open"
}
stop_daemon() {
  vm "AANG_HOME='$(kept "$1" aang_home)' HOME='$(kept "$1" home)' aang stop" >/dev/null || true
}
tunnel() {
  ssh "${ssh_options[@]}" -N -L "127.0.0.1:$1:127.0.0.1:$port" aang@127.0.0.1 &
  tunnels+=("$!")
  sleep 2
}

run_check vm --placement vm --require "${AANG_SURFACE_REQUIRE:-}"
if [ -n "$(kept vm aang_home)" ]; then
  tunnel "$port"
  $check access --link "$(open_link vm)" --origin "http://127.0.0.1:$port" --into "$out/vm/report.json" || status=1
  tunnel "$other"
  $check access --link "$(open_link vm)" --origin "http://127.0.0.1:$other" --expect-write 403 --out "$out/vm/access-other-port.json" || status=1
  for pid in "${tunnels[@]}"; do kill "$pid" 2>/dev/null || true; done
  tunnels=()
  stop_daemon vm
else
  status=1
fi

run_check desktop-ssh --placement desktop_ssh --surfaces claude_desktop,codex_desktop --emulate-desktop
if [ -n "$(kept desktop-ssh aang_home)" ]; then
  tunnel "$port"
  $check access --link "$(open_link desktop-ssh)" --origin "http://127.0.0.1:$port" --into "$out/desktop-ssh/report.json" || status=1
  stop_daemon desktop-ssh
else
  status=1
fi
exit "$status"
