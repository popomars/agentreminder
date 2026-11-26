#!/usr/bin/env bash
set -euo pipefail
umask 077

port=
baud=460800
board=waveshare-amoled-2.16
bootstrap_python=${AGENTREMINDER_BOOTSTRAP_PYTHON:-python3}
check=false
menu_update=false
lang=${AGENTREMINDER_LANG:-zh}
say() { if [[ "$lang" == en ]]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
usage() {
  say '用法：bash flash.sh [--board waveshare-amoled-2.16|folotoy-passport] [--port DEVICE] [--baud RATE] [--check] [--lang zh|en]' \
      'Usage: bash flash.sh [--board waveshare-amoled-2.16|folotoy-passport] [--port DEVICE] [--baud RATE] [--check] [--lang zh|en]'
}
while (( $# )); do
  case "$1" in
    --board)
      case "${2:-}" in waveshare-amoled-2.16|folotoy-passport) board=$2;; *) usage >&2; exit 2;; esac
      shift 2;;
    --port) [[ -n ${2:-} ]] || { usage >&2; exit 2; }; port=$2; shift 2;;
    --baud) [[ ${2:-} =~ ^[0-9]+$ ]] || { usage >&2; exit 2; }; baud=$2; shift 2;;
    --lang) case "${2:-}" in zh|en) lang=$2;; *) usage >&2; exit 2;; esac; shift 2;;
    --check) check=true; shift;;
    --menu-update) menu_update=true; shift;;
    -h|--help) usage; exit 0;;
    *) usage >&2; exit 2;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$board" in
  folotoy-passport)
    image_dir="$root/firmware/release/folotoy-ai-passport"
    chip=esp32c3;;
  waveshare-amoled-2.16)
    image_dir="$root/firmware/release/waveshare-amoled-2.16"
    chip=esp32s3;;
esac
"$bootstrap_python" - "$image_dir" "$lang" "$board" <<'PY'
import hashlib, sys
from pathlib import Path
root = Path(sys.argv[1])
english = sys.argv[2] == 'en'
passport = sys.argv[3] == 'folotoy-passport'
app = 'AgentReminder-AI-Passport-app.bin'
full = 'AgentReminder-AI-Passport-full.bin'
names = {app, full} if passport else {"bootloader.bin", "partitions.bin", "boot_app0.bin", "firmware.bin"}
try:
    for line in (root / "SHA256SUMS").read_text().splitlines():
        expected, name = line.split()
        names.remove(name)
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            raise ValueError(name)
    if names:
        raise ValueError(", ".join(sorted(names)))
    if passport:
        application = (root / app).read_bytes()
        merged = (root / full).read_bytes()
        if (application[:1] != b'\xe9' or int.from_bytes(application[12:14], 'little') != 5
                or len(merged) > 0x310000 or merged[0x10000:] != application):
            raise ValueError("AI Passport image layout")
except (OSError, ValueError, KeyError) as error:
    message = "Firmware files are missing or failed verification. Download them again." if english else "固件不完整或校验失败。请从仓库完整下载后重试。"
    sys.exit(f"{message} {error}")
print("Firmware SHA-256 verification passed." if english else "固件 SHA-256 校验通过。")
PY
if "$check"; then exit 0; fi

state_dir="${AGENTREMINDER_HOME:-"$HOME/.agentreminder"}"
export AGENTREMINDER_HOME="$state_dir"
env_dir="$state_dir/flash/esptool-4.9.0"
python="${AGENTREMINDER_FLASH_PYTHON:-"$env_dir/bin/python"}"
if [[ ! -x "$python" ]]; then
  if [[ -n ${AGENTREMINDER_FLASH_PYTHON:-} ]]; then
    say "找不到指定的 Python：$python" "Python executable not found: $python" >&2
    exit 1
  fi
  "$bootstrap_python" -m venv "$env_dir"
fi
if ! "$python" -c 'import esptool, serial; assert esptool.__version__ == "4.9.0"' 2>/dev/null; then
  "$python" -m pip install 'esptool==4.9.0'
fi

if [[ -z "$port" ]]; then
  port="$("$python" - "$lang" <<'PY'
import sys
from serial.tools import list_ports

ports = [p.device for p in list_ports.comports() if (p.vid, p.pid) == (0x303a, 0x1001)]
if len(ports) != 1:
    message = ("Connect one Espressif USB Serial/JTAG board or pass --port."
               if sys.argv[1] == 'en' else "请只连接一台 Espressif USB Serial/JTAG 设备，或用 --port 指定串口。")
    sys.exit(message + (" " + ", ".join(ports) if ports else ""))
print(ports[0])
PY
)"
fi
[[ -c "$port" ]] || { say "找不到串口：$port" "Serial port not found: $port" >&2; exit 1; }
host="$root/host/agentreminder.js"
table_dir=
restart_daemon=false
lock="$state_dir/firmware-update.pid"
mkdir -p "$state_dir"
"$bootstrap_python" - "$lock" "$$" "$lang" <<'PY_LOCK'
import fcntl, os, sys

filename, owner, language = sys.argv[1:]
with open(filename, 'a+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    lock.seek(0)
    current = lock.read().strip()
    if current.isdecimal() and int(current) > 0:
        try:
            os.kill(int(current), 0)
        except ProcessLookupError:
            current = ""
        except PermissionError:
            pass
        if current:
            sys.exit("A firmware update is already in progress." if language == "en" else "已有固件更新正在进行。")
    lock.seek(0)
    lock.truncate()
    lock.write(owner + '\n')
PY_LOCK
cleanup() {
  : > "$lock"
  if [[ -n "$table_dir" ]]; then
    rm -f "$table_dir/partitions.bin"
    rmdir "$table_dir"
  fi
  if "$restart_daemon"; then node "$host" start; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if "$menu_update"; then
  node "$host" firmware-prepare "$lang"
elif [[ -f "$host" ]] && command -v node >/dev/null; then
  if node "$host" stop --if-running; then
    restart_daemon=true
  else
    stop_code=$?
    if [[ "$stop_code" != 3 ]]; then exit "$stop_code"; fi
  fi
fi

esptool=("$python" -m esptool --chip "$chip" --port "$port" --baud "$baud" --before default_reset --after hard_reset)
if [[ "$board" == folotoy-passport ]]; then
  table_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentreminder-partitions.XXXXXXXX")"
  application="$image_dir/AgentReminder-AI-Passport-app.bin"
  say "正在检查 AI Passport 的分区表：$port" "Checking the AI Passport partition table on $port"
  "${esptool[@]}" read_flash 0x8000 0x1000 "$table_dir/partitions.bin" --no-progress
  "$bootstrap_python" - "$table_dir/partitions.bin" "$application" "$lang" <<'PY'
from hashlib import md5
from pathlib import Path
from struct import unpack
import sys

table = Path(sys.argv[1]).read_bytes()
size = Path(sys.argv[2]).stat().st_size
english = sys.argv[3] == 'en'
partitions = []
verified = False
if len(table) == 0x1000:
    for offset in range(0, 0xC00, 32):
        record = table[offset:offset + 32]
        if record[:16] == b'\xeb\xeb' + b'\xff' * 14:
            padding = table[offset + 32:]
            verified = record[16:] == md5(table[:offset]).digest() and padding == b'\xff' * len(padding)
            break
        magic, kind, subtype, start, length, _, flags = unpack('<HBBII16sI', record)
        if (magic != 0x50AA or start < 0x9000 or length == 0 or start + length > 0x800000
                or start % 0x1000 or length % 0x1000):
            break
        partitions.append((start, start + length, kind, subtype, flags))

partitions.sort()
apps = [(start, end, subtype, flags) for start, end, kind, subtype, flags in partitions if kind == 0]
overlap = any(left[1] > right[0] for left, right in zip(partitions, partitions[1:]))
if (not verified or overlap or len(apps) != 1 or apps[0][0] != 0x10000
        or apps[0][1] < 0x310000 or apps[0][2:] != (0, 0)
        or size > apps[0][1] - apps[0][0]):
    sys.exit("Unsupported AI Passport partition layout. No firmware was written."
             if english else "AI Passport 分区布局不兼容，本次没有写入固件。")
PY
  say "正在写入 AI Passport 的应用分区：$port" "Flashing the AI Passport application partition on $port"
  "${esptool[@]}" write_flash -z --flash_mode keep --flash_freq keep --flash_size keep 0x10000 "$application"
else
  say "正在为微雪 ESP32-S3-Touch-AMOLED-2.16 刷机：$port" "Flashing Waveshare ESP32-S3-Touch-AMOLED-2.16 on $port"
  "${esptool[@]}" write_flash -z --flash_mode dio --flash_freq 80m --flash_size 16MB \
    0x0000 "$image_dir/bootloader.bin" \
    0x8000 "$image_dir/partitions.bin" \
    0xe000 "$image_dir/boot_app0.bin" \
    0x10000 "$image_dir/firmware.bin"
fi
say '刷机成功。设备重启后即可通过 USB 配对。' 'Flashing complete. Once the board restarts, you can pair it over USB.'
