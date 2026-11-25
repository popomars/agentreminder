import CoreBluetooth
import Foundation

private let rxID = CBUUID(string: "B623A0C1-5E48-46D3-BA39-000000000000")
private let txID = CBUUID(string: "B623A0C2-5E48-46D3-BA39-000000000000")

final class Bridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private let service: CBUUID
    private var central: CBCentralManager!
    private var device: CBPeripheral?
    private var rx: CBCharacteristic?
    private var input = Data()
    private var awaitingWrite = false
    private var connected = false

    init(deviceID: String) {
        service = CBUUID(string: "B623A0C0-5E48-46D3-BA39-" + deviceID)
        super.init()
        central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            if bytes.isEmpty { exit(0) }
            DispatchQueue.main.async { self?.write(bytes) }
        }
    }

    private func status(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }

    private func fail(_ message: String) -> Never {
        status(message)
        exit(1)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            status("scanning")
            central.scanForPeripherals(withServices: [service])
        case .poweredOff:
            if device != nil { fail("bluetooth-off") }
            status("bluetooth-off")
        case .unauthorized: fail("bluetooth-permission")
        case .unsupported: fail("bluetooth-unavailable")
        case .resetting: fail("bluetooth-resetting")
        case .unknown: break
        @unknown default: fail("bluetooth-unavailable")
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard device == nil else { return }
        device = peripheral
        central.stopScan()
        status("connecting")
        central.connect(peripheral)
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            if let self, !self.connected { self.fail("gatt-timeout") }
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        peripheral.discoverServices([service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        fail("connect-failed")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        fail("disconnected")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let target = peripheral.services?.first(where: { $0.uuid == service }) else {
            fail("service-unavailable")
        }
        peripheral.discoverCharacteristics([rxID, txID], for: target)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil, let rx = service.characteristics?.first(where: { $0.uuid == rxID }),
              let tx = service.characteristics?.first(where: { $0.uuid == txID }) else {
            fail("characteristic-unavailable")
        }
        self.rx = rx
        peripheral.setNotifyValue(true, for: tx)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.isNotifying else { fail("subscribe-failed") }
        connected = true
        status("ready")
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, let bytes = characteristic.value else { fail("read-failed") }
        FileHandle.standardOutput.write(bytes)
    }

    private func write(_ bytes: Data) {
        guard connected, input.count + bytes.count <= 65_536 else { fail("write-overflow") }
        input.append(bytes)
        pumpWrite()
    }

    private func pumpWrite() {
        guard !awaitingWrite, !input.isEmpty, let device, let rx else { return }
        // The no-response limit is CoreBluetooth's single ATT packet size. Use it
        // for acknowledged writes as well to avoid ATT prepare/execute writes.
        let size = min(input.count, 180, device.maximumWriteValueLength(for: .withoutResponse))
        awaitingWrite = true
        device.writeValue(input.prefix(size), for: rx, type: .withResponse)
        input.removeFirst(size)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil else { fail("write-failed") }
        awaitingWrite = false
        pumpWrite()
    }
}

guard CommandLine.arguments.count == 2,
      CommandLine.arguments[1].range(of: "^[0-9A-Fa-f]{12}$", options: .regularExpression) != nil else {
    exit(2)
}
let bridge = Bridge(deviceID: CommandLine.arguments[1])
withExtendedLifetime(bridge) { dispatchMain() }
