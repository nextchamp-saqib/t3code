#!/usr/bin/env bash
# Fork only. Builds the macOS arm64 app of the mine commit saqib-dev runs, the
# way release-desktop.yml's macOS job does, and installs it with install-mac.sh.
# Run it from Terminal, not inside T3 Code: the install quits the app.
#
#   scripts/release-mine-mac.sh [<version>]
#
# Without a version it builds the one `t3 --version` reports on $T3_MINE_HOST
# (default saqib-dev) over ssh. Builds go to $T3_MINE_DIR (default
# ~/.cache/t3-mine)/releases/v<version>/, and only the installed one is kept.
# It runs only from its own clone, $T3_MINE_DIR/t3code, and first moves that
# clone to origin/mine.
set -euo pipefail

mine_dir="${T3_MINE_DIR:-$HOME/.cache/t3-mine}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.vite-plus/bin:$HOME/.local/share/vite-plus/bin:$HOME/.cargo/bin:$PATH"

check_tools() {
  if [[ "$(uname -s)/$(uname -m)" != Darwin/arm64 ]]; then
    echo "This builds the Apple silicon app; run it on an arm64 Mac." >&2
    exit 1
  fi
  local missing=()
  xcode-select -p > /dev/null 2>&1 && command -v git > /dev/null ||
    missing+=("Xcode command line tools: xcode-select --install")
  if ! command -v vp > /dev/null; then
    missing+=("Vite+: curl -fsSL https://vite.plus | bash")
  # The builds pin Node through Vite+'s shims, which sit next to vp.
  elif [[ "$(command -v node)" != "$(dirname "$(command -v vp)")/node" ]]; then
    missing+=("Node from Vite+: curl -fsSL https://vite.plus | VP_NODE_MANAGER=yes bash")
  fi
  command -v cargo > /dev/null ||
    missing+=("Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh")
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Install these, open a new terminal, and run this again:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 1
  fi
}

# Runs the newest copy of this script. Other checkouts are refused, so nothing fetches into them.
update_self() {
  local clone="$mine_dir/t3code"
  if [[ ! -d "$clone" || "$(cd "$here/.." && pwd)" != "$(cd "$clone" && pwd)" ]]; then
    echo "Run this from its own clone: git clone -b mine https://github.com/nextchamp-saqib/t3code.git $clone" >&2
    exit 1
  fi
  git -C "$clone" fetch -q origin mine
  # mine is force-pushed when it moves to a newer upstream tag, so check out rather than merge.
  if [[ "$(git -C "$clone" rev-parse HEAD)" != "$(git -C "$clone" rev-parse origin/mine)" ]]; then
    git -C "$clone" checkout -q --detach origin/mine
    T3_MINE_UPDATED=1 exec "$here/release-mine-mac.sh" "$@"
  fi
}

server_version() {
  local host="${T3_MINE_HOST:-saqib-dev}" out
  # Skip the host's LocalForward lines: an open session already holds those ports.
  if ! out="$(ssh -o BatchMode=yes -o ClearAllForwardings=yes "$host" '~/.local/bin/t3 --version')"; then
    echo "Could not read the T3 version on $host. Pass it instead: $0 <version>" >&2
    exit 1
  fi
  echo "${out#t3 v}"
}

build() {
  local out="$1"
  prepare
  export T3CODE_RELEASE_BASE_URL="https://github.com/$GITHUB_REPOSITORY/releases/download"
  vp run build:desktop
  # The zip is what install-mac.sh installs; skipping the dmg skips hdiutil.
  T3CODE_DESKTOP_UPDATE_REPOSITORY=none vp run dist:desktop:artifact --platform mac --target zip \
    --arch arm64 --build-version "$version" --skip-build --verbose
  local zips=(release/T3-Code-*-arm64.zip)
  if [[ ${#zips[@]} -ne 1 || ! -f "${zips[0]}" ]]; then
    echo "Expected one macOS arm64 zip, found: ${zips[*]}" >&2
    exit 1
  fi
  mkdir -p "$src/out" "$(dirname "$out")"
  mv "${zips[0]}" "$src/out/"
  (cd "$src/out" && shasum -a 256 T3-Code-*-arm64.zip > SHA256SUMS)
  rm -rf "$out"
  mv "$src/out" "$out"
}

check_tools
[[ -n "${T3_MINE_UPDATED:-}" ]] || update_self "$@"
# shellcheck source=release-mine-linux.sh
source "$here/release-mine-linux.sh"

want="${1:-}"
[[ -n "$want" ]] || want="$(server_version)"
if [[ ! "$want" =~ \+mine\.[0-9a-f]{10}$ ]]; then
  echo "$want is not a mine build (<base>+mine.<sha10>)." >&2
  exit 1
fi
resolve "${want##*+mine.}"
if [[ "$version" != "$want" ]]; then
  echo "Commit ${sha:0:10} builds as $version, not $want." >&2
  exit 1
fi

out="$mine_dir/releases/v$version"
[[ -f "$out/SHA256SUMS" ]] || build "$out"
sh "$here/install-mac.sh" "$version" "$out"
for old in "$mine_dir"/releases/v*; do
  [[ "$old" == "$out" ]] || rm -rf "$old"
done
