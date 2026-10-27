#!/bin/sh
# Fork only. Installs a macOS arm64 release zip into /Applications unless that
# version is already installed. Quits the running app, so run it outside T3 Code.
#
#   scripts/install-mac.sh <version> <dir>    # <dir> holds one T3-Code-*-arm64.zip and its SHA256SUMS
set -eu
version="$1"
dir="$2"
set -- "$dir"/T3-Code-*-arm64.zip
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Expected one arm64 zip in $dir." >&2
  exit 1
fi
zip="$1"
app_name="$(unzip -Z1 "$zip" | sed -n '1s#/.*##p')"
case "$app_name" in
  *.app) ;;
  *) echo "Unexpected first entry in $zip: $app_name" >&2; exit 1 ;;
esac
app="/Applications/$app_name"
app_id="com.t3tools.t3code"
# electron-builder drops +mine from file names, so the installed release is kept in an xattr.
installed="$(xattr -p dev.t3code.release "$app" 2>/dev/null || true)"
if [ "$installed" = "$version" ]; then
  echo "T3 Code $version is already installed."
  exit 0
fi
is_running() {
  [ "$(osascript -e "application id \"$app_id\" is running" 2>/dev/null)" = "true" ]
}
tmp="$(mktemp -d)"
# Puts the previous app back if the script stops between moving it out and moving the new one in.
trap '[ -e "$app" ] || [ ! -e "$tmp/previous" ] || mv "$tmp/previous" "$app"; rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
(cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null)
ditto -x -k "$zip" "$tmp/unpacked"
# The build is unsigned apart from Electron's linker signature; seal the bundle ad hoc.
codesign --force --deep --sign - "$tmp/unpacked/$app_name"
running=false
if is_running; then
  running=true
  osascript -e "tell application id \"$app_id\" to quit"
  for _ in $(seq 60); do
    is_running || break
    sleep 1
  done
  if is_running; then
    echo "T3 Code did not quit; nothing was changed." >&2
    exit 1
  fi
fi
if [ -e "$app" ]; then mv "$app" "$tmp/previous"; fi
mv "$tmp/unpacked/$app_name" "$app"
xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
xattr -w dev.t3code.release "$version" "$app"
if [ "$running" = true ]; then open "$app"; fi
echo "Installed T3 Code $version (was ${installed:-unknown})."
