#!/usr/bin/env bash
# Fork only. Builds the Linux x64 CLI archive for a mine commit the way
# release-mine.yml does, and installs it through `t3 update` from a local
# release directory.
#
#   scripts/release-mine-linux.sh build [<commit>]      # default origin/mine
#   scripts/release-mine-linux.sh install <version> [t3 update flags...]
#
# Needs Vite+ in ~/.local/share/vite-plus and cargo in ~/.cargo. Releases go
# to $T3_MINE_RELEASES (default ~/.cache/t3-mine-releases)/v<version>/, laid
# out like a GitHub release download directory.
set -euo pipefail

export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.cargo/bin:$PATH"
releases="${T3_MINE_RELEASES:-$HOME/.cache/t3-mine-releases}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

build() {
  local ref="${1:-origin/mine}"
  git -C "$repo" fetch -q --tags origin mine
  local sha base version
  sha="$(git -C "$repo" rev-parse "$ref^{commit}")"
  base="$(git -C "$repo" describe --tags --match 'v*-nightly.*' --exclude 'v*+mine.*' --abbrev=0 "$sha")"
  version="${base#v}+mine.${sha:0:10}"
  local out="$releases/v$version"
  if [[ -f "$out/SHA256SUMS" ]]; then
    echo "Already built: $out" >&2
    echo "$version"
    return
  fi

  # A fresh clone, so no local .env or build output leaks into the release.
  local src
  src="$(mktemp -d "${TMPDIR:-/var/tmp}/t3-mine-build.XXXXXX")"
  trap 'rm -rf "$src"' EXIT
  git clone -q --no-checkout "$repo" "$src"
  git -C "$src" sparse-checkout set --no-cone '/*' '!/.repos/'
  git -C "$src" checkout -q --detach "$sha"
  cd "$src"

  local key
  for key in T3CODE_CLERK_PUBLISHABLE_KEY T3CODE_CLERK_JWT_TEMPLATE T3CODE_CLERK_CLI_OAUTH_CLIENT_ID T3CODE_RELAY_URL; do
    export "$key=$(sed -n "s/^$key=//p" .env.example | head -n 1)"
  done

  vp install --filter=t3... --filter=@t3tools/web... --filter=@t3tools/scripts...
  node scripts/update-release-package-versions.ts "$version"
  vp run --filter t3 build
  cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-unknown-linux-gnu

  local brand=production
  if [[ "$version" =~ -nightly\.[0-9]{8}\.[0-9]+$ ]]; then brand=nightly; fi
  node scripts/apply-web-brand-assets.ts "$brand" apps/server/dist/client
  T3CODE_TELEMETRY_CHANNEL=dev node apps/server/scripts/cli.ts build-exe

  mkdir -p "$src/resource-monitor/linux-x64"
  cp native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor "$src/resource-monitor/linux-x64/"
  node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
    --resource-monitor-dir "$src/resource-monitor" --output-dir "$src/release-cli"
  node scripts/smoke-cli-archive.ts --archive "$src"/release-cli/* --expect-version "$version"

  mkdir -p "$out.partial"
  cp "$src"/release-cli/* "$out.partial/"
  (cd "$out.partial" && sha256sum t3-*.tar.gz > SHA256SUMS)
  mv "$out.partial" "$out"
  echo "Built $out" >&2
  echo "$version"
}

install() {
  local version="${1:?usage: install <version> [t3 update flags...]}"
  shift
  [[ -f "$releases/v$version/SHA256SUMS" ]] || { echo "Not built: $releases/v$version" >&2; exit 1; }
  local log port pid
  log="$(mktemp)"
  python3 -u -m http.server --bind 127.0.0.1 0 --directory "$releases" > "$log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null; rm -f "$log"' EXIT
  for _ in $(seq 50); do
    port="$(sed -n 's/.* port \([0-9]*\).*/\1/p' "$log")"
    [[ -n "$port" ]] && break
    sleep 0.1
  done
  [[ -n "$port" ]] || { echo "The local release server did not start: $(cat "$log")" >&2; exit 1; }
  T3CODE_RELEASE_BASE_URL="http://127.0.0.1:$port" "${T3:-$HOME/.local/bin/t3}" update "$version" --yes "$@"
}

case "${1:-}" in
  build) shift; build "$@" ;;
  install) shift; install "$@" ;;
  *) sed -n '2,10p' "$0" >&2; exit 2 ;;
esac
