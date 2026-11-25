# Current Sprint

- Ship a host and firmware installer that uses the same Git commit for both.
- Verify the five-minute approval deadline, physical device queue and source metadata.
- Keep one local daemon. Use a CoreBluetooth helper only for a paired macOS device and the Codex bridge only for the desktop session.
- Provide Chinese and English setup and removal instructions.
- Route supported human-input events to the shared device queue with an explicit desktop handoff.

USB and macOS Bluetooth have passed a physical device round trip. Codex desktop command approvals, physical queue counts, two-choice rendering and desktop handoff have been exercised. A logged-in Claude session, a real dsh profile, Linux hardware, and managed cloud approvals remain outside the verified matrix.

See [Chinese setup](../README.md), [English setup](../README.en.md), [protocol](protocol.md), and [progress](progress.md).
