# Current Sprint

- Ship a host and firmware installer that uses the same Git commit for both.
- Verify the five-minute approval deadline, physical device queue and source metadata.
- Keep one local daemon. Use a CoreBluetooth helper only for a paired macOS device and the Codex bridge only for the desktop session.
- Provide Chinese and English setup and removal instructions.
- Route supported human-input events to the shared device queue with an explicit desktop handoff.

USB and macOS Bluetooth have passed a physical device round trip. Codex desktop command approvals, physical queue counts, two-choice rendering and desktop handoff have been exercised. A logged-in Claude session, a real dsh profile, Linux hardware, and managed cloud approvals remain outside the verified matrix.

Host v0.4.4 and firmware v0.3.5 add receipt times and group completion cards
by host, project, and conversation. The new firmware was flashed and connected
over USB and Bluetooth. Visual layout and physical controls in this build
still await manual confirmation.

The multi-host branch adds automatic Tailnet discovery and peer fan-out to the
daemon. Integration tests cover three daemons with simulated device links.
Two Macs discovered each other without configured addresses and sent a test
notification and approval to physical devices over USB and Bluetooth. Approving
on the USB device cleared the same card on the Bluetooth device, as confirmed
on its screen.

See [Chinese setup](../README.md), [English setup](../README.en.md), [protocol](protocol.md), and [progress](progress.md).
