# AgentReminder progress — 2026-11-25

## Implemented and verified

- Adapted the firmware to the actual Waveshare ESP32-S3-Touch-AMOLED-2.16:
  CO5300 QSPI 480×480, CST9220 touch, 16 MB flash, 8 MB OPI PSRAM.
  The stock ST7789/CST816 template was not usable on this device.
- Built and flashed v0.2.0 over `/dev/cu.usbmodem2101`. Original 16 MB flash is
  backed up at `.runtime/backups/waveshare-before-agentreminder.bin` (not for
  publication; may contain device data). SHA-256:
  `971f6ee2b5cb29c7d7d14254dbc3beb61b4167005b0f6b583fd739e0597a2a39`.
- Real USB handshake and host daemon are running. Device ID `E476C83F1FB8`.
- Touchscreen round trip passed: Claude-compatible allow and Codex-compatible deny.
- Physical keys passed with the user's explicit confirmation at 18:25 Shanghai:
  left GPIO18 rejects, right GPIO0 approves. Center PMU power key is unchanged.
  Keys have 35 ms debounce and ignore held presses when the current card changes.
- Card shows the conversation name, agent, project, tool, approval reason and
  operation details. Current Codex session resolves to `完善 Agent ESP32 审批插件`.
  Codex prefers the SQLite thread `name`, then `title`. Claude uses session index
  or transcript custom title/first prompt. Explicit hook titles take priority.
- Replaced the limited built-in SimSun subset with generated Noto Sans SC
  18px/2bpp: basic CJK, Latin-1, kana, punctuation and arrows. Initial compressed
  font build showed boxes because `LV_USE_FONT_COMPRESSED` was disabled; fixed.
  `LV_FONT_FMT_TXT_LARGE` is also required. Boot self-test decodes Chinese, ASCII
  and symbols into actual pixel buffers; latest USB handshake has `font_ok: true`.
  User confirmed final display is correct.
- Completion notification after the physical test was sent. Physical results are
  `.runtime/hardware-check.json`; earlier touch results are
  `.runtime/hardware-check-touchscreen.json`.
- Eight Node tests pass, including actual hook subprocesses → HTTP daemon → TCP
  simulator → structured allow/deny/skip output, completion notifications, UTF-8
  split reads, disconnection/cancellation, config preservation and chat metadata.
- Fixed disconnection fallback, remaining-time replay, untrusted/unidentified
  link decisions, malformed-settings overwrite, generated command quoting,
  CODEX_HOME/AGENTREMINDER_HOME paths, child log fd leak and device liveness.

## Installed on this Mac

- Claude: `~/.claude/settings.json`, PermissionRequest/Notification/Stop.
- Codex: `~/.codex/hooks.json`, PermissionRequest/Stop. Codex's own hook trust
  review is still required; installing the file does not imply trust.
- dsh bridge config generated: `~/.agentreminder/dsh-hooks.json`. dsh is not
  installed locally; a real profile still needs the bridge and the supplied
  Cordis patch. Its PreToolUse matcher now includes lowercase harness tool names.
  Allow/deny output contract was tested, not a live dsh permission policy.

## Real-agent validation limits

The successful USB checks invoke the real installed hook entry point with test
payloads; they do not execute the displayed operation. They are not proof that
an agent's own lifecycle/trust integration has been fully accepted.

A real Claude CLI (2.0.76) print invocation reached its Stop hook (daemon log
18:07:15), but the model call failed with `Invalid API key · Please run /login`.
No successful Claude model/tool session has been accepted yet. Do not replace
credentials without the owner's input.

The shell's `/opt/homebrew/bin/codex` is an old broken installation (missing its
vendor executable). A usable app-bundled CLI exists at
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`
(version `0.167.0-alpha.3.2`). No successful real Codex approval session has been
accepted yet, and hook trust was not bypassed.

## Remaining transports / remote work

macOS supports BLE following USB enrollment on firmware 0.3.0 and host 0.4.0.
On a Waveshare 2.16-inch board, USB enrollment, a real Codex approval returned
over BLE after unplugging USB, completion-card display, and automatic BLE
reconnection were verified. The macOS terminal helper builds for arm64 and x86_64.
Optional Wi-Fi TCP code remains available for existing standalone setups.

The combined installer can verify and flash the checked-in firmware before
installing hooks. The uninstaller only removes managed host files and hooks and
stops the local daemon. A duplicate daemon exit leaves the device transports to
the process that owns the localhost port. The macOS Bluetooth helper waits for
the radio to turn back on without repeatedly spawning.
Remote SSH forwarding instructions are in README; no real remote agent has been
accepted. Managed cloud tasks need their platform's actual event/approval surface,
not an assumption that a local lifecycle hook works there.

## Commands

```sh
node host/agentreminder.js status
node --test host/test/*.test.js
AGENTREMINDER_TEST_SESSION_ID=<current-session-id> node host/tools/hardware-check.js
PLATFORMIO_CORE_DIR="$PWD/.platformio" .venv/bin/pio run -d firmware
```

The flash script releases the USB port and restarts the local daemon if it was running.
Keep `.venv/`, `.platformio/`, `.runtime/` and firmware `.pio/` out of plugin
packages/repositories. Font regeneration and licensing are in `firmware/src/fonts`.

## Owning references

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Waveshare source and schematic](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.16)
- [Waveshare board pin map](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16)

## USB install and precompiled images

Host v0.4.5 and Waveshare firmware v0.3.15 are bundled together. `bash install.sh --flash`
verifies the images, flashes the board, installs hooks, and enables USB pairing.
The board shows a confirmation card when a new host requests enrollment.
Run `bash flash.sh --check` to verify the four images, or `bash flash.sh` to
write them with the same offsets used by PlatformIO.

The current board passed the two-choice test with the right physical button and
returned the next request to the computer on a short center PWR press.
