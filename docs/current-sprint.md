# Current Sprint

Deliver the host runtime, firmware sources, and first-run installer in the private
GitHub repository. Users can download the installer with GitHub CLI or run it from
a clone, then enroll an existing ESP32 over USB.

- USB firmware and button approvals passed prior physical testing.
- Codex requires hook trust review after install.
- Claude needs a valid login for a real session test.
- dsh needs its bridge configured in the selected profile.
- BLE and managed cloud approvals remain future work.

See [README](../README.md), [progress](progress.md), and [protocol](protocol.md).

The host installer now writes hooks before USB enrollment. It supports an
authenticated curl download and waits in the background for the first device.
The checked-in firmware images and `flash.sh` cover the supported Waveshare board.
