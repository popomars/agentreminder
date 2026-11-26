import AppKit

private struct Installation: Decodable {
    let node: String
    let statePath: String
    let language: String

    var stateDirectory: URL { URL(fileURLWithPath: statePath, isDirectory: true) }

    var host: URL { stateDirectory.appendingPathComponent("app/host/agentreminder.js") }

    var endpoint: URL {
        let file = stateDirectory.appendingPathComponent("config.json")
        let settings = (try? Data(contentsOf: file))
            .flatMap { try? JSONDecoder().decode(Settings.self, from: $0) }
        var url = URLComponents()
        url.scheme = "http"
        url.host = "127.0.0.1"
        let port = settings?.httpPort ?? 47321
        url.port = (1...65535).contains(port) ? port : 47321
        return url.url!
    }

    private struct Settings: Decodable { let httpPort: Int? }
}

private struct Card: Decodable {
    let id: String
    let title: String
    let detail: String?
    let host: String?
    let project: String?
    let conversation: String?
    let receivedTime: String?
    let unread: Bool?
    let kind: String?

    var summary: String {
        [host, project, conversation, receivedTime].compactMap { $0 }
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

private struct Inbox: Decodable {
    let notifications: [Card]
    let unread: Int
    let approvals: [Card]
    let devices: Int
    let canClear: Bool?
}

private struct Pairing: Decodable {
    let deviceId: String?
    let bluetoothPaired: Bool?
    let error: String?
}

private struct ReadResult: Decodable { let ok: Bool }

@MainActor
private final class MenuBar: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let installation: Installation
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let session: URLSession
    private var inbox: Inbox?
    private var timer: Timer?
    private var refreshing = false
    private var starting: Process?
    private var lastStart = Date.distantPast
    private var pairing = false
    private var trackingMenu = false

    init(installation: Installation) {
        self.installation = installation
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForResource = 75
        session = URLSession(configuration: config)
    }

    private func label(_ chinese: String, _ english: String) -> String {
        installation.language == "en" ? english : chinese
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        item.menu = menu
        menu.autoenablesItems = false
        menu.delegate = self
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "bell.badge", accessibilityDescription: "AgentReminder")
            button.imagePosition = .imageLeading
        }
        redraw()
        refresh()
        timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }

    private func request<T: Decodable>(
        _ path: String, method: String = "GET", body: Data? = nil, timeout: TimeInterval = 2
    ) async throws -> T {
        var request = URLRequest(url: installation.endpoint.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.httpBody = body
        if method == "POST" { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) || (path == "pair" && http.statusCode == 409)
        else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func refresh() {
        if !FileManager.default.fileExists(atPath: installation.host.path) {
            NSApp.terminate(nil)
            return
        }
        guard !refreshing else { return }
        refreshing = true
        Task {
            defer { refreshing = false }
            do {
                inbox = try await request("inbox")
                if inbox?.canClear != true { startService() }
            }
            catch {
                inbox = nil
                startService()
            }
            redraw()
        }
    }

    private func startService(force: Bool = false) {
        guard starting == nil, force || Date().timeIntervalSince(lastStart) >= 10 else { return }
        let process = Process()
        let executable = URL(fileURLWithPath: installation.node)
        process.executableURL = executable
        process.arguments = [installation.host.path, "menu-start"]
        var environment = ProcessInfo.processInfo.environment
        environment["AGENTREMINDER_HOME"] = installation.stateDirectory.path
        let nodeDirectory = executable.deletingLastPathComponent().path
        environment["PATH"] = [nodeDirectory, environment["PATH"] ?? "", "/opt/homebrew/bin", "/usr/local/bin",
                               "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                self?.starting = nil
                self?.refresh()
            }
        }
        lastStart = Date()
        do {
            try process.run()
            starting = process
        } catch { starting = nil }
    }

    private func action(_ title: String, _ selector: Selector? = nil, enabled: Bool = true) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        entry.target = self
        entry.isEnabled = enabled
        return entry
    }

    private func oneLine(_ text: String, limit: Int) -> String {
        let line = text.split(whereSeparator: \.isNewline).joined(separator: " ")
        return line.count > limit ? String(line.prefix(limit - 1)) + "…" : line
    }

    private func cardTitle(_ card: Card, notification: Bool) -> String {
        guard notification else { return card.title }
        return card.kind == "done" ? label("任务完成", "Task completed") : card.title
    }

    private func addCards(_ cards: [Card], title: String, notifications: Bool = false) {
        let entry = action(title, enabled: !cards.isEmpty)
        if !cards.isEmpty {
            let list = NSMenu(title: title)
            list.autoenablesItems = false
            for card in cards {
                let subject = oneLine(cardTitle(card, notification: notifications), limit: notifications ? 32 : 72)
                let context = notifications ? [card.host, card.project, card.conversation].compactMap { $0 }
                    .map { oneLine($0, limit: 24) }.filter { !$0.isEmpty } : []
                let caption = (context + [subject]).joined(separator: " · ")
                let row = action((card.unread == true ? "● " : "") + caption, #selector(showCard(_:)))
                row.representedObject = card.id
                list.addItem(row)
            }
            if notifications {
                list.addItem(.separator())
                list.addItem(action(label("清除所有通知", "Clear all notifications"),
                                    #selector(clearNotifications), enabled: inbox?.canClear == true))
            }
            entry.submenu = list
        }
        menu.addItem(entry)
    }

    func menuWillOpen(_ menu: NSMenu) { trackingMenu = true }

    func menuDidClose(_ menu: NSMenu) {
        trackingMenu = false
        Task { redraw() }
    }

    private func redraw() {
        guard !trackingMenu else { return }
        menu.removeAllItems()
        if let inbox {
            item.button?.title = label("通知 \(inbox.unread) · 审批 \(inbox.approvals.count)",
                                       "\(inbox.unread) new · \(inbox.approvals.count) approvals")
            menu.addItem(action(label("已连接 \(inbox.devices) 台设备", "\(inbox.devices) connected devices"), enabled: false))
            addCards(inbox.notifications, title: label("通知（\(inbox.unread) 未读）", "Notifications (\(inbox.unread) unread)"),
                     notifications: true)
            addCards(inbox.approvals, title: label("待审批（\(inbox.approvals.count)）", "Pending approvals (\(inbox.approvals.count))"))
            menu.addItem(action(label("全部标为已读", "Mark all as read"), #selector(markAll), enabled: inbox.unread > 0))
            menu.addItem(action(label("清除所有审批和通知", "Clear all approvals and notifications"),
                                #selector(clearAll),
                                enabled: inbox.canClear == true && (!inbox.approvals.isEmpty || !inbox.notifications.isEmpty)))
        } else {
            item.button?.title = "AgentReminder"
            menu.addItem(action(label("正在连接服务", "Connecting to service"), enabled: false))
            menu.addItem(action(label("重试连接", "Retry connection"), #selector(retry)))
        }
        menu.addItem(.separator())
        if pairing {
            menu.addItem(action(label("请连接 USB 并在设备上确认", "Connect by USB and confirm on the device"), enabled: false))
        } else {
            menu.addItem(action(label("配对新设备…", "Pair a new device…"), #selector(pair), enabled: inbox != nil))
        }
        menu.addItem(action(label("退出菜单栏应用", "Quit menu bar app"), #selector(quit)))
    }

    @objc private func retry() { startService(force: true) }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func showCard(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let inbox,
              let card = (inbox.notifications + inbox.approvals).first(where: { $0.id == id }) else { return }
        if card.unread == true { markRead([id]) }
        let message = [card.summary, card.detail ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
        showAlert(cardTitle(card, notification: card.unread != nil), message)
    }

    @objc private func markAll() { markRead(inbox?.notifications.filter { $0.unread == true }.map(\.id) ?? []) }

    private func markRead(_ ids: [String]) {
        Task {
            let body = try? JSONEncoder().encode(["ids": ids])
            let _: ReadResult? = try? await request("inbox/read", method: "POST", body: body)
            refresh()
        }
    }

    @objc private func clearNotifications() { clearInbox(includeApprovals: false) }
    @objc private func clearAll() { clearInbox(includeApprovals: true) }

    private func clearInbox(includeApprovals: Bool) {
        guard let inbox, inbox.canClear == true else { return }
        let cards = ["notifications": inbox.notifications.map(\.id),
                     "approvals": includeApprovals ? inbox.approvals.map(\.id) : []]
        Task {
            do {
                let body = try JSONEncoder().encode(cards)
                let _: ReadResult = try await request("inbox/clear", method: "POST", body: body)
                refresh()
            } catch {
                showAlert(label("清除失败", "Could not clear the inbox"),
                          label("请检查 AgentReminder 服务后重试。", "Check the AgentReminder service and try again."))
            }
        }
    }

    @objc private func pair() {
        guard !pairing else { return }
        pairing = true
        redraw()
        Task {
            defer { pairing = false; redraw(); refresh() }
            do {
                var result: Pairing?
                for _ in 0..<30 {
                    let reply: Pairing = try await request("pair", method: "POST", body: Data("{}".utf8), timeout: 70)
                    result = reply
                    guard reply.error == "no-usb" else { break }
                    try await Task.sleep(nanoseconds: 500_000_000)
                }
                if let result, let id = result.deviceId {
                    let text = result.bluetoothPaired == true
                        ? label("蓝牙已配对。连接稳定后可拔掉 USB。", "Bluetooth paired. Unplug USB after it connects.") : id
                    showAlert(label("配对完成", "Device paired"), text)
                } else { showPairingError(result?.error) }
            } catch { showPairingError(nil) }
        }
    }

    private func showPairingError(_ error: String?) {
        let message: String
        switch error {
        case "no-usb":
            message = label("请用数据线连接一台已刷好固件的设备，再试一次。", "Connect a device with AgentReminder firmware over USB and try again.")
        case "multiple-usb":
            message = label("检测到多台可配对设备，请只保留本次要配对的一台。", "Connect only the device you want to pair.")
        case "approval-pending":
            message = label("请先处理当前审批，再配对新设备。", "Resolve the pending approvals before pairing.")
        case "timeout", "deny":
            message = label("请在设备屏幕上确认配对后重试。", "Try again and confirm the pairing prompt on the device.")
        default:
            message = label("请检查设备和 USB 连接后重试。", "Check the device and USB connection, then try again.")
        }
        showAlert(label("配对未完成", "Pairing incomplete"), message)
    }

    private func showAlert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

@main
private struct AgentReminderApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        guard let config = Bundle.main.url(forResource: "Installation", withExtension: "json"),
              let data = try? Data(contentsOf: config),
              let installation = try? JSONDecoder().decode(Installation.self, from: data) else {
            let error = NSAlert()
            error.messageText = "AgentReminder installation is incomplete."
            error.runModal()
            exit(1)
        }
        let menuBar = MenuBar(installation: installation)
        app.setActivationPolicy(.accessory)
        app.delegate = menuBar
        withExtendedLifetime(menuBar) { app.run() }
    }
}
