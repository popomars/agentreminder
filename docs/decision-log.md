# Decision Log

> Purpose: preserve why consequential choices were made so future contributors do not repeatedly reopen settled questions. ChatGPT should help compare options and draft entries. Codex should read relevant entries before changing architecture or contracts and append an entry when a new durable decision is accepted. Never rewrite history; mark superseded entries and link to the replacement.

## Status vocabulary

- **Proposed**: under discussion; not yet authoritative.
- **Accepted**: current direction.
- **Superseded**: replaced by a newer linked decision.
- **Rejected**: considered and intentionally not chosen.

## Entry template

Copy this section for each decision. Use IDs such as `ADR-0001`.

### ADR-XXXX: [Decision title]

- Date: YYYY-MM-DD
- Status: Proposed
- Owners: [Names or roles]
- Related: [Issue, PR, document, or replacing ADR]

#### Context

[What forces, constraints, or problem require a decision?]

#### Decision

[State the chosen direction clearly.]

#### Options considered

1. **[Option]** — [Key advantages and disadvantages]
2. **[Option]** — [Key advantages and disadvantages]

#### Consequences

- Positive: [Expected benefit]
- Negative: [Accepted cost or limitation]
- Follow-up: [Required work or validation]

---

## Decisions

### ADR-0001: Install the host from GitHub and enroll over USB

- Date: 2026-11-25
- Status: Accepted

The installer copies the host runtime from one GitHub commit or a local checkout.
A physical confirmation on the single attached device enrolls its ID on the host.
The enrolled host sends approval cards and notifications over that USB connection.
This works with the existing firmware and keeps setup independent of the firmware toolchain.

### ADR-0002: Mirror native Codex approvals through the App Server

- Date: 2026-11-25
- Status: Accepted

Codex's desktop launcher mirrors the App Server's native command and file
requests over USB. The first decision wins. The pre-prompt AgentReminder
permission hook yields inside this launch mode so the native prompt can open.

### ADR-0003: Version the firmware and host together

- Date: 2026-11-25
- Status: Accepted

The host installer can flash the bundled Waveshare firmware when explicitly
invoked with `--flash`. A remote install resolves a Git commit first and takes
both its runtime and firmware from that commit. Firmware integrity is verified
before flashing. The HTTP listener owns the USB and Bluetooth transports so
concurrent hook startup cannot attach duplicate device clients. Uninstall keeps
pairing data and removes only the installer-managed files and hooks.

### ADR-0004: Timestamp cards at receipt and group completed conversations

- Date: 2026-11-25
- Status: Accepted

The daemon stamps cards in its local time when it first receives the event.
The device can display that time without maintaining a wall clock, and a
pending card keeps the same timestamp across transport replays. The device
keeps the latest completion per source host, project, and conversation.
A session ID distinguishes conversations with the same title. Firmware can
still display cards from an older daemon that sends no formatted timestamp.

### ADR-0005: Build AI Passport as an independent community play

- Date: 2026-11-25
- Status: Accepted on the FoloToy branch

Use the same AgentReminder host and authenticated USB-enrolled Bluetooth link
for both boards. Build the Passport application for ESP32-C3 and package it
as a community-play image. Also provide an application-only image for devices
with a compatible factory partition, so an installation can keep the existing
partition table, identity data and assets. The full image is bounded by the
start of the asset partitions observed on the test board.

The installation and flash scripts require an explicit Passport board selection.
The script verifies the existing partition table before writing only the factory
application. The full image remains available for the community-play installer.

### ADR-0006: Share cards across enrolled devices

- Date: 2026-11-25
- Status: Accepted on the FoloToy branch

Keep one host daemon with a per-board enrollment key. Accept legacy single-board
settings so existing enrollments survive an upgrade. Send each request ID to
all eligible links and broadcast its first resolution to the connected devices.

### ADR-0007: Mirror cards directly between selected Tailnet peers

- Date: 2026-11-25
- Status: Accepted

Every participating computer runs the same daemon and connects directly to its
peer list, discovered through Tailscale by default. Both peers prove possession
of the shared key before any card is sent. The source daemon owns the response
to its agent. Receivers serve cards locally without forwarding them. A separate
Tailnet listener keeps hook administration and pairing on loopback. The macOS
Tailnet service menu exposes initialization, joining, and key viewing as
separate actions. The optional installer flag opens initialization. The
daemon activates the mesh in place and retains its inbox and pending
approvals. Group keys stay in private local configuration and can be
copied during initialization or from the key dialog.

### ADR-0008: Show AgentReminder in the macOS menu bar

- Date: 2026-11-26
- Status: Accepted

The macOS installer installs a signed application bundle in the user's
Applications folder and launches it through Launch Services. The menu can
run after the installing terminal closes. Upgrades replace the old bell
without restarting the same-version daemon. The app starts or connects to
the host daemon on loopback. Headless installations can use
`--no-menu-bar`. Pairing, firmware and the local delivery test are in
the bell menu. The installer registers the macOS login item by default.
The menu checks the published application version and revision on GitHub.
Agent integrations shows Codex Dock configuration alongside the Claude Code,
dsh and WorkBuddy hooks. Hook switches gate local forwarding at runtime and
preserve existing third-party settings. Codex applies its configuration the
next time ChatGPT opens.
The daemon owns unread counts and retains the latest notification in each
host, project, and conversation group, up to 100 groups. The app shows the
latest notification and its reception time. The app uses the existing USB pairing endpoint and the
same device confirmation as the command-line flow.

The AgentReminder login item also restores opt-in Codex Dock configuration.
Launch migrates the older AgentReminder-owned Codex LaunchAgent, which
macOS displayed as `sh`, into the menu app's startup.

### ADR-0009: Share the ES8311 notification player across boards

- Date: 2026-11-26
- Status: Accepted

Both firmware targets use one background playback task and trigger it after
the card queue accepts a new approval, question, or notification. Each board
provides its own I2S pins. Waveshare shares its existing I2C bus with the
touch controller and PMIC, and enables the speaker amplifier just for playback.

### ADR-0010: Share screen behavior across Waveshare and Passport

- Date: 2026-11-26
- Status: Accepted

Waveshare uses the same idle status layout, notification paging and reading
behavior. Touch targets follow the edge with the physical keys. Waveshare
keeps its left, center and right approval actions. Sound uses the shared
preference, and the square panel uses LVGL rotation and matching touch input
when the controls move to the right edge.

### ADR-0011: Remind users to confirm WorkBuddy command approvals on the Mac

- Date: 2026-11-26
- Status: Accepted

WorkBuddy Desktop forwards task completion through its `Stop` hook.
WorkBuddy 5.11.3 emits a command safety audit event when its native approval
appears. The existing AgentReminder daemon reads that event from the live
spool or daily audit file and sends a notification. It deduplicates both
sources and omits shell commands and arguments. The user makes the approval
decision in WorkBuddy. One menu switch controls both WorkBuddy paths.
