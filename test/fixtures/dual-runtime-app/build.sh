#!/usr/bin/env bash
set -euo pipefail

: "${FLEET_ARTIFACT_DIR:?Fleet must provide FLEET_ARTIFACT_DIR}"
: "${FLEET_ARTIFACT_MANIFEST:?Fleet must provide FLEET_ARTIFACT_MANIFEST}"
: "${FLEET_RUNTIME:?Fleet must provide FLEET_RUNTIME}"

root="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$root/dist"
trap 'rm -rf "$root/dist"; rm -f "$root/src-tauri/icons/icon.png"; rmdir "$root/src-tauri/icons" 2>/dev/null || true' EXIT
install -d -m 700 "$root/dist" "$root/src-tauri/icons" "$FLEET_ARTIFACT_DIR/bin"
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR42u3OIQEAAAgDMNoQi9q0gRg3E/Ornr2kEhAQEBAQEBAQEBAQEBAQSAcexTt0iO0MLAYAAAAASUVORK5CYII=' | base64 -d > "$root/src-tauri/icons/icon.png"
printf '<!doctype html><html lang="en"><meta charset="UTF-8"><title>Fleet Runtime Fixture</title><body><main><h1>Fleet Runtime Fixture</h1><label>Runtime result <input aria-label="Runtime result"></label></main><script type="module" src="/main.js"></script></body></html>\n' > "$root/dist/index.html"
bun build "$root/src/main.ts" --target=browser --outfile="$root/dist/main.js"

export CEF_PATH="${CEF_PATH:-$HOME/.local/share/cef}"
cargo build --manifest-path "$root/src-tauri/Cargo.toml" --no-default-features --features "$FLEET_RUNTIME"
target_dir="$(cargo metadata --manifest-path "$root/src-tauri/Cargo.toml" --no-deps --format-version 1 | bun -e 'console.log((await Bun.stdin.json()).target_directory)')"
install -m 755 "$target_dir/debug/tauri-fleet-runtime-fixture" "$FLEET_ARTIFACT_DIR/bin/app"

if [ "$FLEET_RUNTIME" = cef ]; then
  for file in libcef.so libEGL.so libGLESv2.so libvk_swiftshader.so libvulkan.so.1 \
    chrome-sandbox chrome_100_percent.pak chrome_200_percent.pak icudtl.dat \
    resources.pak v8_context_snapshot.bin vk_swiftshader_icd.json; do
    install -m 755 "$target_dir/debug/$file" "$FLEET_ARTIFACT_DIR/bin/$file"
  done
  cp -a "$target_dir/debug/locales" "$FLEET_ARTIFACT_DIR/bin/"
fi

bun -e '
const cef = process.env.FLEET_RUNTIME === "cef"
await Bun.write(process.env.FLEET_ARTIFACT_MANIFEST, JSON.stringify({
  protocol: "tauri-agent-artifact/v1",
  executable: "bin/app",
  ...(cef ? {
    args: ["--no-sandbox", "--single-process", "--in-process-gpu"],
    cwd: "bin",
    env: { CEF_PATH: process.env.CEF_PATH, LD_LIBRARY_PATH: "." }
  } : {})
}) + "\n")
'
