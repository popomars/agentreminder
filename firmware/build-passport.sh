#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="$root/.pio/build/folotoy-passport"
out="${1:-$root/release/folotoy-ai-passport}"
image=AgentReminder-AI-Passport-full.bin
application=AgentReminder-AI-Passport-app.bin
python=${PASSPORT_PYTHON:-python3}

"${PLATFORMIO:-pio}" run -d "$root" -e folotoy-passport
mkdir -p "$out"
stage="$(mktemp -d "$out/.passport.XXXXXXXX")"
trap 'rm -r -- "$stage"' EXIT

# Factory-app layout. Arduino's boot_app0 OTA initializer does not belong here.
"$python" -m esptool --chip esp32c3 merge_bin --flash_mode dio --flash_size 8MB \
  --output "$stage/$image" 0x0 "$build/bootloader.bin" \
  0x8000 "$build/partitions.bin" 0x10000 "$build/firmware.bin"

cp "$build/firmware.bin" "$stage/$application"
"$python" - "$stage/$image" "$stage/$application" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys

image, app = map(Path, sys.argv[1:])
data = image.read_bytes()
application = app.read_bytes()
if len(data) > 0x310000 or data[0x10000:] != application:
    sys.exit("Unexpected application offset or write range in AI Passport image.")
image.with_name("SHA256SUMS").write_text(
    f"{sha256(data).hexdigest()}  {image.name}\n"
    f"{sha256(application).hexdigest()}  {app.name}\n"
)
PY
mv "$stage/$image" "$stage/$application" "$stage/SHA256SUMS" "$out"
printf 'AI Passport community play: %s/%s\n' "$out" "$image"
