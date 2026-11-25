#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/agentreminder-ble.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "${arch}-apple-macosx13.0" -module-cache-path "$stage/modules" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$dir/Info.plist" \
    "$dir/Bridge.swift" -o "$stage/$arch"
done
xcrun lipo -create "$stage/arm64" "$stage/x86_64" -output "$stage/agentreminder-bluetooth"
codesign --force --sign - --identifier com.agentreminder.bluetooth "$stage/agentreminder-bluetooth"
mv "$stage/agentreminder-bluetooth" "$dir/agentreminder-bluetooth"
