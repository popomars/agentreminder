import AppKit
import ServiceManagement

private struct Installation: Decodable {
    let node: String
    let python: String?
    let statePath: String
    let language: String

    var stateDirectory: URL { URL(fileURLWithPath: statePath, isDirectory: true) }

    var loginItemMarker: URL { stateDirectory.appendingPathComponent("login-item-registered") }
    var host: URL { stateDirectory.appendingPathComponent("app/host/agentreminder.js") }
    var flashScript: URL { stateDirectory.appendingPathComponent("app/flash.sh") }
    var legacyApp: URL { stateDirectory.appendingPathComponent("app/AgentReminder.app") }
    var codexSetup: URL { stateDirectory.appendingPathComponent("app/host/configure-codex-dock.js") }

    var codexApp: URL? {
        let locations = [URL(fileURLWithPath: "/Applications"), FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications")]
        return locations.map { $0.appendingPathComponent("ChatGPT.app") }.first { app in
            let cli = app.appendingPathComponent("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
            return FileManager.default.isExecutableFile(atPath: cli.path)
        }
    }

    var processEnvironment: [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let nodeDirectory = URL(fileURLWithPath: node).deletingLastPathComponent().path
        environment["AGENTREMINDER_HOME"] = stateDirectory.path
        if let python { environment["AGENTREMINDER_BOOTSTRAP_PYTHON"] = python }
        environment["PATH"] = [nodeDirectory, environment["PATH"] ?? "", "/opt/homebrew/bin", "/usr/local/bin",
                               "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        return environment
    }

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
    let canUpdateFirmware: Bool?
    let canSendTest: Bool?
}

private struct Pairing: Decodable {
    let deviceId: String?
    let bluetoothPaired: Bool?
    let error: String?
}

private struct ReadResult: Decodable { let ok: Bool }
private struct TestResult: Decodable { let delivered: Int }

private enum FirmwareBoard: String, CaseIterable {
    case waveshare = "waveshare-amoled-2.16"
    case passport = "folotoy-passport"

    var name: String {
        switch self {
        case .waveshare: "Waveshare ESP32-S3 Touch AMOLED 2.16"
        case .passport: "FoloToy AI Passport"
        }
    }
}

private struct FirmwareUpdate {
    let board: FirmwareBoard
    let directory: URL
    let process: Process

    var logFile: URL { directory.appendingPathComponent("flash.log") }

    var latestLines: [String] {
        guard let log = try? FileHandle(forReadingFrom: logFile) else { return [] }
        defer { try? log.close() }
        guard let end = try? log.seekToEnd() else { return [] }
        let start = end > 4096 ? end - 4096 : 0
        try? log.seek(toOffset: start)
        guard let tail = try? log.read(upToCount: 4096) else { return [] }
        return String(decoding: tail, as: UTF8.self).split(whereSeparator: \.isNewline).map(String.init)
    }
}

@MainActor
private final class MenuBar: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let installation: Installation
    private lazy var item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let session: URLSession
    private var inbox: Inbox?
    private var timer: Timer?
    private var refreshing = false
    private var starting: Process?
    private var lastStart = Date.distantPast
    private var pairing = false
    private var setupUsb = ProcessInfo.processInfo.arguments.contains("--setup-usb")
    private var configuringCodex = false
    private var trackingMenu = false
    private var firmwareUpdate: FirmwareUpdate?

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
        guard ProcessInfo.processInfo.arguments.contains("--replace-existing"),
              let bundleID = Bundle.main.bundleIdentifier else {
            showMenu()
            return
        }
        let current = NSRunningApplication.current
        let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath()
        let legacy = installation.legacyApp.resolvingSymlinksInPath()
        let paths = [bundle, legacy]
        let previous = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).filter {
            $0.processIdentifier != current.processIdentifier &&
                $0.bundleURL.map { paths.contains($0.resolvingSymlinksInPath()) } == true &&
                ($0.launchDate ?? .distantPast) <= (current.launchDate ?? .distantFuture)
        }
        previous.forEach { _ = $0.terminate() }
        Task {
            for _ in 0..<40 {
                let stopped = previous.allSatisfy { application in
                    application.isTerminated || (kill(application.processIdentifier, 0) == -1 && errno == ESRCH)
                }
                if stopped {
                    if legacy != bundle, Bundle(url: legacy)?.bundleIdentifier == bundleID {
                        try? FileManager.default.removeItem(at: installation.legacyApp)
                    }
                    showMenu()
                    return
                }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            showAlert(label("新版已安装", "Update installed"),
                      label("旧版铃铛还在运行。设备操作结束后，退出铃铛，再从访达打开 AgentReminder。",
                            "The previous bell is still running. When device operations finish, quit it and reopen AgentReminder from Finder."))
            NSApp.terminate(nil)
        }
    }

    private func showMenu() {
        item.menu = menu
        menu.autoenablesItems = false
        menu.delegate = self
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "bell.badge", accessibilityDescription: "AgentReminder")
            button.imagePosition = .imageLeading
        }
        redraw()
        Task {
            let defaultState = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".agentreminder")
            if installation.stateDirectory.resolvingSymlinksInPath().path == defaultState.resolvingSymlinksInPath().path {
                do {
                    let result = try await runCodexSetup("restore")
                    if result.exitCode != 0 {
                        NSLog("AgentReminder could not restore Codex Dock configuration: %@",
                              String(decoding: result.output, as: UTF8.self))
                    }
                } catch { NSLog("AgentReminder could not run Codex Dock setup: %@", error.localizedDescription) }
            }
        }
        if ProcessInfo.processInfo.arguments.contains("--register-login"),
           !UserDefaults.standard.bool(forKey: "AgentReminderLoginItemOptOut") {
            registerAtLogin()
        }
        if setupUsb { startService(force: true) }
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
                if inbox?.canSendTest != true { startService() }
            }
            catch {
                inbox = nil
                startService()
            }
            redraw()
        }
    }

    private func startService(force: Bool = false) {
        guard firmwareUpdate == nil, starting == nil, force || Date().timeIntervalSince(lastStart) >= 10 else { return }
        let process = Process()
        let executable = URL(fileURLWithPath: installation.node)
        process.executableURL = executable
        process.arguments = [installation.host.path, setupUsb ? "setup-usb" : "menu-start"]
        process.environment = installation.processEnvironment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] completed in
            let succeeded = completed.terminationStatus == 0
            Task { @MainActor in
                if succeeded { self?.setupUsb = false }
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

    private func clearAction(_ title: String, notifications: [Card], approvals: [Card] = []) -> NSMenuItem {
        let entry = action(title, #selector(clearInbox(_:)),
                           enabled: inbox?.canClear == true && (!notifications.isEmpty || !approvals.isEmpty))
        entry.representedObject = ["notifications": notifications.map(\.id), "approvals": approvals.map(\.id)]
        return entry
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
                let time = notifications ? card.receivedTime.flatMap { $0.isEmpty ? nil : $0 } : nil
                let caption = (context + [subject] + [time].compactMap { $0 }).joined(separator: " · ")
                let row = action((card.unread == true ? "● " : "") + caption, #selector(showCard(_:)))
                row.representedObject = card
                list.addItem(row)
            }
            if notifications {
                list.addItem(.separator())
                list.addItem(clearAction(label("清除所有通知", "Clear all notifications"), notifications: cards))
            }
            entry.submenu = list
        }
        menu.addItem(entry)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        firmwareUpdate == nil && !pairing && !configuringCodex ? .terminateNow : .terminateCancel
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
            menu.addItem(clearAction(label("清除所有审批和通知", "Clear all approvals and notifications"),
                                     notifications: inbox.notifications, approvals: inbox.approvals))
        } else {
            item.button?.title = "AgentReminder"
            menu.addItem(action(label("正在连接服务", "Connecting to service"), enabled: false))
            menu.addItem(action(label("重试连接", "Retry connection"), #selector(retry)))
        }
        menu.addItem(.separator())
        addFirmwareMenu()
        if pairing {
            menu.addItem(action(label("请连接 USB 并在设备上确认", "Connect by USB and confirm on the device"), enabled: false))
        } else {
            menu.addItem(action(label("配对新设备…", "Pair a new device…"), #selector(pair), enabled: inbox != nil && firmwareUpdate == nil))
        }
        menu.addItem(action(label("发送测试通知", "Send test notification"), #selector(sendTest),
                            enabled: inbox?.canSendTest == true && firmwareUpdate == nil))
        if installation.codexApp != nil {
            let codex = action(label("Codex 桌面双端审批", "Codex Desktop approvals"))
            let options = NSMenu(title: codex.title)
            options.autoenablesItems = false
            for (title, command) in [(label("启用…", "Enable…"), "install"), (label("停用…", "Disable…"), "uninstall")] {
                let option = action(title, #selector(configureCodex(_:)), enabled: !configuringCodex)
                option.representedObject = command
                options.addItem(option)
            }
            codex.submenu = options
            menu.addItem(codex)
        }
        menu.addItem(.separator())
        let login = action(label("登录时启动", "Launch at login"), #selector(toggleLoginItem))
        switch SMAppService.mainApp.status {
        case .enabled: login.state = .on
        case .requiresApproval: login.state = .mixed
        default: break
        }
        menu.addItem(login)
        menu.addItem(action(label("退出菜单栏应用", "Quit menu bar app"), #selector(quit), enabled: firmwareUpdate == nil))
    }

    @objc private func retry() { startService(force: true) }
    @objc private func quit() { NSApp.terminate(nil) }

    private func registerAtLogin() {
        let service = SMAppService.mainApp
        if service.status == .notRegistered || service.status == .notFound {
            do { try service.register() } catch {
                NSLog("AgentReminder login item registration failed: %@", error.localizedDescription)
            }
        }
        if service.status == .enabled || service.status == .requiresApproval {
            FileManager.default.createFile(atPath: installation.loginItemMarker.path, contents: nil)
        }
    }

    @objc private func toggleLoginItem() {
        let service = SMAppService.mainApp
        switch service.status {
        case .requiresApproval:
            SMAppService.openSystemSettingsLoginItems()
        case .enabled:
            do {
                try service.unregister()
                UserDefaults.standard.set(true, forKey: "AgentReminderLoginItemOptOut")
                try? FileManager.default.removeItem(at: installation.loginItemMarker)
            } catch {
                showAlert(label("无法关闭登录启动", "Could not disable launch at login"), error.localizedDescription)
            }
        default:
            UserDefaults.standard.removeObject(forKey: "AgentReminderLoginItemOptOut")
            registerAtLogin()
            if service.status != .enabled {
                showAlert(label("请检查登录项", "Check Login Items"),
                          label("在系统设置的「登录项与扩展」中允许 AgentReminder。",
                                "Allow AgentReminder in System Settings under Login Items & Extensions."))
            }
        }
        redraw()
    }

    @objc private func sendTest() {
        Task {
            do {
                let body = try JSONEncoder().encode(["lang": installation.language])
                let result: TestResult = try await request("inbox/test", method: "POST", body: body)
                refresh()
                if result.delivered == 0 {
                    showAlert(label("已发送测试通知", "Test notification sent"),
                              label("铃铛的「通知」里可以查看。设备连上后可再试一次。",
                                    "See it under Notifications in the bell menu. Send another test after connecting a device."))
                }
            } catch {
                showAlert(label("无法发送测试通知", "Could not send the test notification"),
                          label("请检查铃铛是否已连接本机服务。", "Check the bell’s connection to the local service."))
            }
        }
    }

    private func runCodexSetup(_ command: String, app: URL? = nil) async throws -> (exitCode: Int32, output: Data) {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: installation.node)
            process.arguments = [installation.codexSetup.path, command]
            var environment = installation.processEnvironment
            if let app { environment["AGENTREMINDER_CODEX_APP"] = app.path }
            process.environment = environment

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.terminationHandler = { completed in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: (completed.terminationStatus, data))
            }
            do {
                try process.run()
                try? pipe.fileHandleForWriting.close()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    @objc private func configureCodex(_ sender: NSMenuItem) {
        guard !configuringCodex, let command = sender.representedObject as? String,
              let app = installation.codexApp else { return }
        let enable = command == "install"
        let restartMessage = label("配置完成后，完全退出 ChatGPT，再从原来的 Dock 图标打开。",
                                   "After applying this setting, quit ChatGPT and reopen it from the usual Dock icon.")
        let alert = NSAlert()
        alert.messageText = enable ? label("启用 Codex 双端审批？", "Enable Codex Desktop approvals?")
                                   : label("停用 Codex 双端审批？", "Disable Codex Desktop approvals?")
        alert.informativeText = restartMessage
        alert.addButton(withTitle: label("取消", "Cancel"))
        alert.addButton(withTitle: label("应用", "Apply"))
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertSecondButtonReturn else { return }

        configuringCodex = true
        redraw()
        Task {
            defer { configuringCodex = false; redraw() }
            do {
                let result = try await runCodexSetup(command, app: app)
                if result.exitCode == 0 {
                    showAlert(label("Codex 配置已应用", "Codex setup applied"), restartMessage)
                } else {
                    showAlert(label("无法更新 Codex 配置", "Could not update Codex setup"),
                              String(decoding: result.output, as: UTF8.self))
                }
            } catch {
                showAlert(label("无法启动 Codex 配置", "Could not start Codex setup"), error.localizedDescription)
            }
        }
    }

    @objc private func showCard(_ sender: NSMenuItem) {
        guard let card = sender.representedObject as? Card else { return }
        if card.unread == true { markRead([card.id]) }
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

    @objc private func clearInbox(_ sender: NSMenuItem) {
        guard let cards = sender.representedObject as? [String: [String]] else { return }
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

    private func addFirmwareMenu() {
        if let update = firmwareUpdate {
            menu.addItem(action(label("正在更新固件", "Updating firmware"), enabled: false))
            if let line = update.latestLines.last {
                menu.addItem(action(String(line.prefix(100)), enabled: false))
            }
            return
        }

        let ready = inbox?.canUpdateFirmware == true && !pairing &&
            FileManager.default.fileExists(atPath: installation.flashScript.path)
        let entry = action(label("安装或更新固件…", "Install or update firmware…"), enabled: ready)
        if ready {
            let models = NSMenu(title: entry.title)
            models.autoenablesItems = false
            for board in FirmwareBoard.allCases {
                let choice = action(board.name, #selector(updateFirmware(_:)))
                choice.representedObject = board.rawValue
                models.addItem(choice)
            }
            entry.submenu = models
        }
        menu.addItem(entry)
    }

    @objc private func updateFirmware(_ sender: NSMenuItem) {
        guard firmwareUpdate == nil, !pairing, let model = sender.representedObject as? String,
              let board = FirmwareBoard(rawValue: model), let inbox, inbox.canUpdateFirmware == true else { return }
        guard inbox.approvals.isEmpty else {
            showAlert(label("有待审批的请求", "Pending approvals"),
                      label("请处理审批后再更新固件。", "Finish the pending approvals before updating firmware."))
            return
        }

        let confirm = NSAlert()
        confirm.messageText = label("为 \(board.name) 安装或更新固件？",
                                    "Install or update firmware on \(board.name)?")
        let usb = label("只用 USB 数据线连接这一台设备，写入时请保持连接。将使用安装包附带的固件。",
                        "Connect only this board with a USB data cable and leave it connected while writing. The bundled firmware will be used.")
        let setup: String
        switch board {
        case .waveshare:
            setup = label("刷写会替换板上的现有程序。找不到串口时，按住 BOOT/− 键接入 USB，再松开按键。",
                          "Flashing replaces the program on the board. If the port is missing, hold BOOT/− while connecting USB, then release it.")
        case .passport:
            setup = label("首次安装前请备份原固件。只有分区兼容的设备才会写入应用。",
                          "Back up the original firmware before your first installation. The app is written only when the partition layout is compatible.")
        }
        confirm.informativeText = usb + "\n\n" + setup
        confirm.alertStyle = .warning
        confirm.addButton(withTitle: label("取消", "Cancel"))
        confirm.addButton(withTitle: label("开始刷写", "Start flashing"))
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertSecondButtonReturn else { return }
        runFirmwareUpdate(board)
    }

    private func runFirmwareUpdate(_ board: FirmwareBoard) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentreminder-update-" + UUID().uuidString, isDirectory: true)
        let process = Process()
        let update = FirmwareUpdate(board: board, directory: directory, process: process)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            try Data().write(to: update.logFile)
            let log = try FileHandle(forWritingTo: update.logFile)
            defer { try? log.close() }

            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [installation.flashScript.path, "--board", board.rawValue, "--menu-update",
                                 "--lang", installation.language]
            process.environment = installation.processEnvironment
            process.standardOutput = log
            process.standardError = log
            process.terminationHandler = { [weak self] completed in
                let code = completed.terminationStatus
                Task { @MainActor in self?.finishFirmwareUpdate(code) }
            }
            firmwareUpdate = update
            try process.run()
            redraw()
        } catch {
            firmwareUpdate = nil
            try? FileManager.default.removeItem(at: directory)
            showAlert(label("无法启动固件更新", "Could not start the firmware update"), error.localizedDescription)
            redraw()
        }
    }

    private func finishFirmwareUpdate(_ code: Int32) {
        guard let update = firmwareUpdate else { return }
        let details = update.latestLines.suffix(10).joined(separator: "\n")
        firmwareUpdate = nil
        try? FileManager.default.removeItem(at: update.directory)
        refresh()
        redraw()
        if code == 0 {
            showAlert(label("固件刷写完成", "Firmware flashed"),
                      label("\(update.board.name) 正在重启。首次安装请保持 USB 连接，从铃铛菜单选择「配对新设备…」。",
                            "\(update.board.name) is restarting. For a first installation, keep USB connected and choose Pair a new device… in the bell menu."))
        } else {
            showAlert(label("固件更新失败", "Firmware update failed"), details)
        }
    }

    @objc private func pair() {
        guard !pairing, firmwareUpdate == nil else { return }
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
            message = label("请用 USB 数据线连接一台已刷好固件的设备。首次使用时，请先在铃铛菜单选择「安装或更新固件…」。",
                            "Connect a device with AgentReminder firmware using a USB data cable. For first-time setup, choose Install or update firmware… in the bell menu first.")
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
        if ProcessInfo.processInfo.arguments.contains("--unregister-login") {
            let service = SMAppService.mainApp
            if service.status == .enabled || service.status == .requiresApproval {
                do { try service.unregister() } catch { exit(1) }
            }
            try? FileManager.default.removeItem(at: installation.loginItemMarker)
            return
        }
        let menuBar = MenuBar(installation: installation)
        app.setActivationPolicy(.accessory)
        app.delegate = menuBar
        withExtendedLifetime(menuBar) { app.run() }
    }
}
