# AgentReminder protocol

Every message is one JSON object per line (NDJSON, UTF-8, `\n`). USB and Wi-Fi use the same protocol.

- **USB**: ESP32-S3 native USB CDC (`/dev/cu.usbmodem*`). The host scans it automatically.
- **Wi-Fi**: the device runs a TCP server on port `47322` and advertises mDNS `agentreminder.local`. The host connects to it as a client.

USB is enabled by default; Wi-Fi must be enabled explicitly in the host configuration. BLE is not implemented.

The host ignores any line that is not JSON, such as boot logs. A link only counts as a device once it has answered `hello` with `"app":"agentreminder"`.

## Host → device

| t | Fields | Meaning |
|---|---|---|
| `hello` | `host, v` | Handshake, sent right after connecting |
| `ping` | `ts` | Heartbeat every 15 s |
| `approval` | `id, agent, project, sessionId, conversation, reason, title, detail, timeout` | Approval request. The device deduplicates by `id`. |
| `resolved` | `id, decision, by` | Approval settled (here or on another channel). Remove the card. |
| `cancel` | `id, why` | Agent side cancelled (hook process exited or timed out). Remove the card. |
| `notify` | `id, agent, project, sessionId, conversation, kind(done/idle/info), title, detail` | Notification |
| `wifi` | `ssid, pass` | Write the Wi-Fi config to NVS and reconnect |

## Device → host

| t | Fields | Meaning |
|---|---|---|
| `hello` | `app:"agentreminder", fw, id, link, ip?` | Handshake reply |
| `pong` | `ts` | Heartbeat reply |
| `decision` | `id, decision(allow/deny/skip)` | User choice. `skip` = hand it back to the agent's own terminal prompt |
| `log` | `msg` | Debug output, written to the daemon log |

## Hook ↔ daemon (127.0.0.1:47321)

- `POST /approval {timeoutSec, info}` → long-polls until it returns `{decision: "allow"|"deny"|null, reason}`
- `POST /notify {info}` → `{delivered: n}`
- `POST /pair {}` → asks the sole connected USB device for confirmation and saves its ID on allow. Ordinary cards and decisions are restricted to the enrolled USB ID after pairing.
- `GET /status`, `POST /raw` (broadcast as-is), `POST /shutdown`

`decision: null` (no device, timeout, or the user tapped "终端") makes the hook print nothing, so the agent falls back to its normal approval flow.

The last device disconnecting cancels outstanding requests immediately. Heartbeats expire after 40 seconds without a device response. Approval IDs are UUIDs; reconnects replay only pending approvals with their remaining timeout. The device also expires stale approval cards locally if a cancellation cannot arrive.

`conversation` is the current chat name; `reason` is the agent-provided approval message. `title` remains the tool name and `detail` the operation arguments. Session transcripts are inspected locally only for their title/first prompt, never forwarded wholesale.
