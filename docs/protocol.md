# AgentReminder protocol

Every application message is one JSON object per line (NDJSON, UTF-8, `\n`). USB, Bluetooth and Wi-Fi share the card protocol.

- **USB**: ESP32-S3 native USB CDC (`/dev/cu.usbmodem*`). The host scans it automatically.
- **Bluetooth LE**: macOS CoreBluetooth central and an ESP32 GATT peripheral. The installer includes a universal macOS helper. The host stays connected when USB is present so unplugging does not interrupt an approval.
- **Wi-Fi**: the device runs a TCP server on port `47322` and advertises mDNS `agentreminder.local`. The host connects to it as a client.

USB and Bluetooth are enabled by default on macOS. Bluetooth only advertises and connects after USB enrollment. Wi-Fi must be configured explicitly.

The host ignores any line that is not JSON, such as boot logs. A link only counts as a device once it has answered `hello` with `"app":"agentreminder"`.

## Host → device

| t | Fields | Meaning |
|---|---|---|
| `hello` | `host, v` | Handshake, sent right after connecting. `host` identifies the connected host on the idle screen. |
| `ping` | `ts` | Heartbeat every 15 s |
| `approval` | `id, agent, host, project, sessionId, conversation, reason, title, detail, timeout, ts, receivedTime?` | Approval request. The device deduplicates by `id`. |
| `resolved` | `id, decision, by` | Approval settled (here or on another channel). Remove the card. |
| `cancel` | `id, why` | Agent side cancelled (hook process exited or timed out). Remove the card. |
| `notify` | `id, agent, host, project, sessionId, conversation, kind(done/input/idle/info), title, detail, ts, receivedTime?, sequence?` | Notification |
| `ble-pair` | `id, conversation, key` | USB-only setup. Device shows its pairing approval. On allow it saves the new 32-byte hex key in NVS before replying `decision` with `ble_paired:true`. |
| `wifi` | `ssid, pass` | Write the Wi-Fi config to NVS and reconnect |

## Device → host

| t | Fields | Meaning |
|---|---|---|
| `hello` | `app:"agentreminder", fw, id, link, ip?, ble?, ble_paired?, board?, sound?, orientation?` | Handshake reply. `ble:1` indicates USB enrollment support. Firmware that supports chimes reports its sound setting. AI Passport also reports `board:"folotoy-passport"` and its screen orientation. |
| `pong` | `ts` | Heartbeat reply |
| `decision` | `id, decision(allow/deny/skip)` | User choice. `skip` = hand it back to the agent's own terminal prompt |
| `log` | `msg` | Debug output, written to the daemon log |

## Bluetooth session

The GATT service UUID is `B623A0C0-5E48-46D3-BA39-<12 hex characters of board ID>`.
The write and notify characteristics use `B623A0C1-5E48-46D3-BA39-000000000000` and `B623A0C2-5E48-46D3-BA39-000000000000`, respectively. ATT values form ordered byte streams that may split frames anywhere.

Each frame starts with a two-byte big-endian payload length. The host and device send a fresh 16-byte random nonce in that order. All subsequent frames carry AES-256-GCM ciphertext followed by a 16-byte tag, with a separate key and sequence in each direction. Derive each key with HMAC-SHA256 using the USB enrollment key and the concatenation of `agentreminder-ble-v1:<c2d or d2c>:` (ASCII), the host nonce and the device nonce. The 12-byte GCM nonce is four zero bytes followed by the big-endian 64-bit sequence, starting at zero. The first encrypted exchange is the regular `hello`. The host verifies the board ID before it accepts approvals from this link. The daemon's pairing configuration is stored with mode `0600`.

## Hook ↔ daemon (127.0.0.1:47321)

- `POST /approval {timeoutSec, info}` → long-polls until it returns `{decision: "allow"|"deny"|null, reason}`
- `POST /notify {info}` → `{delivered: n}`
- `GET /inbox` → local menu bar view with unread count, recent notifications, active non-pairing approvals and the number of connected devices. Notifications are held in memory, up to 100 per daemon run. The inbox requires a loopback Host header.
- `POST /inbox/read {ids: [...]}` → marks the listed notifications read. Reads do not settle approvals or affect boards.
- `POST /inbox/clear {notifications: [...], approvals: [...]}` → removes the listed local notifications and hands the listed pending approvals back to their originating clients. The app sends the IDs it displayed, so cards arriving after that snapshot stay in the inbox.
- `POST /pair {}` → asks one connected USB device for confirmation, preferring an unpaired device when there is exactly one. On macOS, compatible firmware stores a Bluetooth enrollment key after confirmation. The daemon retains earlier board enrollments. Ordinary cards and decisions are restricted to registered USB devices and their authenticated Bluetooth links once at least one device is paired. The daemon broadcasts the first resolution to every ready link.
- `GET /status`, `POST /raw` (broadcast as-is), `POST /shutdown`

`decision: null` (no device, timeout, or the user tapped "终端") makes the hook print nothing, so the agent falls back to its normal approval flow.

The default approval deadline is 300 seconds from receipt. The device displays the oldest approval and the total pending count. Each request keeps its own deadline while queued.

- `POST /interaction {timeoutSec, info}` is the human-input counterpart to `/approval`. This endpoint dispatches an `approval` wire message with `interaction:true` only to firmware that advertises `interaction:true` in its handshake. Older firmware receives an informational notification.
- An interaction with `choices:[left,right]` maps `deny` and `allow` to the left and right option. `skip` hands control back to the computer without an answer. An interaction without choices accepts only `skip`. The Codex bridge cancels a mirrored interaction when the desktop or App Server resolves it.

The optional Codex desktop launcher mirrors native command and file approvals
through the App Server stdio proxy. It sends the request to the desktop before
waiting for the same decision on the device. A desktop response or
`serverRequest/resolved` aborts the matching `/approval` call, which closes the
device card. A device choice sends a single native `accept` or `decline` response.
The AgentReminder permission hook exits early only in this launcher mode.

The last device disconnecting cancels outstanding requests immediately. Heartbeats expire after 40 seconds without a device response. Approval IDs are UUIDs; reconnects replay only pending approvals with their remaining timeout. The device also expires stale approval cards locally if a cancellation cannot arrive.

`conversation` is the current chat name; `reason` is the agent-provided approval message. `title` remains the tool name and `detail` the operation arguments. Session transcripts are inspected locally only for their title/first prompt, never forwarded wholesale.

On cards, `host` identifies the machine where the agent runs, which may differ from the connected host when forwarding over SSH. `project` is the basename of the agent's working directory. The daemon fills in its own hostname for older hooks or local HTTP clients that omit it. The device also accepts older daemons and can use the handshake host if a card lacks `host`.

`ts` is the receiving daemon's Unix time in milliseconds. `receivedTime` is the same instant formatted in that daemon's local time as `MM-DD HH:mm`. Replayed approvals keep both fields. Firmware omits the display time on older cards that lack `receivedTime`.

The device groups `done` notifications by `host`, `project`, and `sessionId`. When both cards lack a session ID, a known conversation title can identify the group. For each group the device displays the latest card, comparing `ts` and using the daemon's `sequence` to order notifications with the same timestamp. Other notification kinds retain their individual cards.

## SSH 远程 agent

设备留在本机时，在远程主机用 `bash install.sh --no-pair` 安装 hooks，设置远程
`~/.agentreminder/config.json` 中的 `httpPort` 为 `47331`。保持本机守护进程运行，
从本机执行：

```bash
ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:47331:127.0.0.1:47321 user@remote
```

远程运行 `node ~/.agentreminder/app/host/agentreminder.js status`，检查是否看到
本机 USB 设备。SSH 转发步骤仍待真实远程 agent 验证。

## Tailnet peer transport

Each enabled daemon opens a separate IPv4 listener, bound to its configured
Tailscale IPv4 address. It refreshes candidates from `tailscale status --json`
every ten seconds, with explicit addresses available as an override. Before a
card is sent, `POST /v1/peer` authenticates both ends using HMAC proofs bound
to the two addresses. The receiving daemon gives the sender a single-use
challenge for its signed `POST /v1/card` body. The key stays local.
The local hook, pairing, shutdown, and raw endpoints stay on loopback.

The originating daemon sends `{card, timeoutMs}` to each peer. A receiver sends
the existing card to its local device without forwarding it further. The
origin assigns the card ID and timestamp once. Approval HTTP requests remain
open for the local device decision. The origin accepts one valid outcome,
closes the other requests, and clears its own card. A closed origin connection
cancels incoming peer cards. Unreachable peers are skipped and events are not
queued for offline peers.
