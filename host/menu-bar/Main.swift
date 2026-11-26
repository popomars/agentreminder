import AppKit
import ServiceManagement
import UniformTypeIdentifiers

private struct Installation: Decodable {
    let node: String
    let python: String?
    let revision: String?
    let statePath: String
    let language: String

    var stateDirectory: URL { URL(fileURLWithPath: statePath, isDirectory: true) }

    var usesDefaultStateDirectory: Bool {
        let standard = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".agentreminder")
        return stateDirectory.resolvingSymlinksInPath().path == standard.resolvingSymlinksInPath().path
    }

    var loginItemMarker: URL { stateDirectory.appendingPathComponent("login-item-registered") }
    var configFile: URL { stateDirectory.appendingPathComponent("config.json") }
    var host: URL { stateDirectory.appendingPathComponent("app/host/agentreminder.js") }
    var flashScript: URL { stateDirectory.appendingPathComponent("app/flash.sh") }
    var legacyApp: URL { stateDirectory.appendingPathComponent("app/AgentReminder.app") }
    var codexSetup: URL { stateDirectory.appendingPathComponent("app/host/configure-codex-dock.js") }

    private static let codexBundleIDs = ["com.openai.codex", "com.openai.chat"]
    private var codexAppPreference: String { "CodexAppPath:" + statePath }

    func supportsCodexApp(_ app: URL) -> Bool {
        guard let id = Bundle(url: app)?.bundleIdentifier, Self.codexBundleIDs.contains(id) else { return false }
        let cli = app.appendingPathComponent("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
        return FileManager.default.isExecutableFile(atPath: cli.path)
    }

    func selectCodexApp(_ app: URL) {
        UserDefaults.standard.set(app.path, forKey: codexAppPreference)
    }

    var codexApp: URL? {
        if let path = UserDefaults.standard.string(forKey: codexAppPreference) {
            let selected = URL(fileURLWithPath: path)
            if supportsCodexApp(selected) { return selected }
        }
        let running = Self.codexBundleIDs.flatMap {
            NSRunningApplication.runningApplications(withBundleIdentifier: $0).compactMap(\.bundleURL)
        }
        let registered = Self.codexBundleIDs.flatMap { NSWorkspace.shared.urlsForApplications(withBundleIdentifier: $0) }
        let standard = [URL(fileURLWithPath: "/Applications/ChatGPT.app"),
                        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/ChatGPT.app")]
        return (running + registered + standard).first(where: supportsCodexApp)
    }

    var processEnvironment: [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let nodeDirectory = URL(fileURLWithPath: node).deletingLastPathComponent().path
        environment["AGENTREMINDER_HOME"] = stateDirectory.path
        if let python { environment["AGENTREMINDER_BOOTSTRAP_PYTHON"] = python }
        let localBin = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path
        environment["PATH"] = [nodeDirectory, environment["PATH"] ?? "", localBin, "/opt/homebrew/bin", "/usr/local/bin",
                               "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        return environment
    }

    var endpoint: URL {
        let settings = (try? Data(contentsOf: configFile))
            .flatMap { try? JSONDecoder().decode(Settings.self, from: $0) }
        var url = URLComponents()
        url.scheme = "http"
        url.host = "127.0.0.1"
        let port = settings?.httpPort ?? 47321
        url.port = (1...65535).contains(port) ? port : 47321
        return url.url!
    }

    var tailnetKey: String? {
        let key = (try? Data(contentsOf: configFile))
            .flatMap { try? JSONDecoder().decode(Settings.self, from: $0) }?.tailnet?.key
        guard let key, key.count == 64, key.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil else { return nil }
        return key
    }

    private struct Settings: Decodable {
        struct Tailnet: Decodable { let key: String? }
        let httpPort: Int?
        let tailnet: Tailnet?
    }
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
    let canInitializeTailnet: Bool?
    let tailnetConfigured: Bool?
    let tailnetListening: Bool?
    let canManageIntegrations: Bool?
    let agentIntegrations: [String: String]?
    let canManageSleepPrevention: Bool?
    let sleepPrevention: SleepPrevention?
}

private struct SleepPrevention: Decodable {
    let supported: Bool
    let enabled: Bool
    let active: Bool
}

private struct Pairing: Decodable {
    let deviceId: String?
    let bluetoothPaired: Bool?
    let error: String?
}

private struct ReadResult: Decodable { let ok: Bool }
private struct TestResult: Decodable { let delivered: Int }
private struct TailnetSetupResult: Decodable { let ok: Bool?; let error: String? }
private struct CodexDockStatus: Decodable { let dockOverrideActive: Bool }
private struct AgentIntegrationResult: Decodable { let status: String; let installedHooks: Bool? }
private enum AgentIntegration: String, CaseIterable {
    case codex, codexDesktop, claude, dsh, workbuddy

    struct Action {
        let agent: AgentIntegration
        let enabled: Bool
    }
}

private enum IntegrationStatus: String { case enabled, disabled, unconfigured, unavailable, notInstalled }
private enum TailnetSetupMode: String { case create, join }

private final class TailnetKeyField: NSSecureTextField {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        if modifiers == .command, event.charactersIgnoringModifiers == "v", let editor = currentEditor() {
            // The menu bar app has no Edit menu to dispatch the paste shortcut.
            editor.paste(self)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

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
    private var serviceNeedsStartup = true
    private var lastStart = Date.distantPast
    private var pairing = false
    private var setupUsb = ProcessInfo.processInfo.arguments.contains("--setup-usb")
    private var configuringCodex = false
    private var changingSleepPrevention = false
    private var codexDockStatus: CodexDockStatus?
    private var codexStatusCheck: Task<Void, Never>?
    private var codexMenuItem: NSMenuItem?
    private var notificationMenuItem: NSMenuItem?
    private var configuringTailnet = false
    private var updatingHookAgents: Set<AgentIntegration> = []
    private var checkingUpdates = false
    private var installingUpdate = false
    private var initTailnetOnLaunch = ProcessInfo.processInfo.arguments.contains("--init-tailnet")
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
            if installation.usesDefaultStateDirectory {
                do {
                    let result = try await runCodexSetup("restore", app: installation.codexApp)
                    if result.exitCode != 0 {
                        NSLog("AgentReminder could not restore Codex Dock configuration: %@",
                              String(decoding: result.output, as: UTF8.self))
                    }
                } catch { NSLog("AgentReminder could not run Codex Dock setup: %@", error.localizedDescription) }
            }
            refreshCodexStatus()
        }
        if ProcessInfo.processInfo.arguments.contains("--register-login"),
           !UserDefaults.standard.bool(forKey: "AgentReminderLoginItemOptOut") {
            registerAtLogin()
        }
        startService(force: true)
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
        if path == "tailnet/setup" || path == "agent-integrations" || path == "sleep-prevention" {
            let tokenFile = installation.stateDirectory.appendingPathComponent("menu-setup.token")
            let token = try String(contentsOf: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            request.setValue(token, forHTTPHeaderField: "X-AgentReminder-Setup")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) || (path == "pair" && http.statusCode == 409) ||
                (path == "tailnet/setup" && [400, 409].contains(http.statusCode))
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
                if serviceNeedsStartup || inbox?.canManageIntegrations == nil || inbox?.canInitializeTailnet == nil {
                    startService()
                }
                if initTailnetOnLaunch && inbox?.canInitializeTailnet == true {
                    initTailnetOnLaunch = false
                    Task {
                        if inbox?.tailnetConfigured == true { showTailnetKey() }
                        else { initializeTailnet() }
                    }
                }
            }
            catch {
                inbox = nil
                startService()
            }
            redraw()
        }
    }

    private func startService(force: Bool = false) {
        guard !installingUpdate, firmwareUpdate == nil, starting == nil,
              force || Date().timeIntervalSince(lastStart) >= 10 else { return }
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
                if succeeded {
                    self?.setupUsb = false
                    self?.serviceNeedsStartup = false
                }
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
        if notifications { notificationMenuItem = entry }
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
        firmwareUpdate == nil && !pairing && !configuringCodex && !configuringTailnet ? .terminateNow : .terminateCancel
    }

    func menuWillOpen(_ menu: NSMenu) {
        trackingMenu = true
        refreshCodexStatus()
    }

    func menuDidClose(_ menu: NSMenu) {
        trackingMenu = false
        Task { redraw() }
    }

    private func redraw() {
        if let inbox {
            item.button?.title = label("通知 \(inbox.unread) · 审批 \(inbox.approvals.count)",
                                       "\(inbox.unread) new · \(inbox.approvals.count) approvals")
        }
        if trackingMenu {
            guard let inbox, let entry = notificationMenuItem else { return }
            let visibleIds = Set(inbox.notifications.map(\.id))
            entry.title = label("通知（\(inbox.unread) 未读）", "Notifications (\(inbox.unread) unread)")
            for row in entry.submenu?.items ?? [] {
                if let card = row.representedObject as? Card, !visibleIds.contains(card.id) { row.isHidden = true }
            }
            return
        }
        menu.removeAllItems()
        codexMenuItem = nil
        notificationMenuItem = nil
        if installingUpdate {
            menu.addItem(action(label("正在安装 AgentReminder 更新…", "Installing AgentReminder update…"), enabled: false))
            return
        }
        if let inbox {
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
        addTailnetMenu()
        addAgentIntegrations()
        menu.addItem(.separator())
        let sleep = action(label("阻止闲置睡眠", "Prevent idle sleep"), #selector(toggleSleepPrevention),
                           enabled: inbox?.canManageSleepPrevention == true && !changingSleepPrevention)
        if let prevention = inbox?.sleepPrevention, prevention.enabled {
            sleep.state = prevention.active ? .on : .mixed
        }
        menu.addItem(sleep)
        let login = action(label("登录时启动", "Launch at login"), #selector(toggleLoginItem))
        switch SMAppService.mainApp.status {
        case .enabled: login.state = .on
        case .requiresApproval: login.state = .mixed
        default: break
        }
        menu.addItem(login)
        menu.addItem(action(label("检查更新…", "Check for updates…"), #selector(checkForUpdates),
                            enabled: !checkingUpdates))
        menu.addItem(action(label("退出菜单栏应用", "Quit menu bar app"), #selector(quit), enabled: firmwareUpdate == nil))
    }

    @objc private func retry() { startService(force: true) }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func toggleSleepPrevention() {
        guard inbox?.canManageSleepPrevention == true, let prevention = inbox?.sleepPrevention,
              prevention.supported, !changingSleepPrevention else { return }
        changingSleepPrevention = true
        redraw()
        Task {
            defer { changingSleepPrevention = false; refresh(); redraw() }
            do {
                let body = try JSONEncoder().encode(["enabled": !prevention.enabled])
                let result: ReadResult = try await request("sleep-prevention", method: "POST", body: body)
                guard result.ok else { throw URLError(.badServerResponse) }
                inbox = try await request("inbox")
            } catch {
                showAlert(label("无法更改闲置睡眠设置", "Could not change the idle sleep setting"),
                          label("请检查本机 AgentReminder 服务。", "Check the local AgentReminder service."))
            }
        }
    }

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

    private func fetchUpdateMetadata(_ path: String, accept: String) async throws -> Data {
        let url = URL(string: "https://api.github.com/repos/popomars/agentreminder/\(path)")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue(accept, forHTTPHeaderField: "Accept")
        let (data, result) = try await URLSession.shared.data(for: request)
        guard let response = result as? HTTPURLResponse, response.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    @objc private func checkForUpdates() {
        guard !checkingUpdates else { return }
        checkingUpdates = true
        redraw()
        Task {
            defer { checkingUpdates = false; redraw() }
            do {
                let data = try await fetchUpdateMetadata("commits/main", accept: "application/vnd.github.sha")
                let revision = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                guard revision.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil else {
                    throw URLError(.cannotDecodeContentData)
                }
                let localVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
                let plist = try await fetchUpdateMetadata("contents/host/menu-bar/Info.plist?ref=\(revision)",
                                                          accept: "application/vnd.github.raw+json")
                let values = try PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any]
                guard let remoteVersion = values?["CFBundleShortVersionString"] as? String else {
                    throw URLError(.cannotDecodeContentData)
                }
                let order = remoteVersion.compare(localVersion, options: .numeric)
                let sameVersionDifferentCommit = order == .orderedSame && installation.revision.map { $0 != revision } == true
                if order == .orderedAscending || (order == .orderedSame && !sameVersionDifferentCommit) {
                    showAlert(label("当前版本已是最新", "AgentReminder is up to date"),
                              label("本机 \(localVersion) · GitHub \(remoteVersion)", "Installed \(localVersion) · GitHub \(remoteVersion)"))
                    return
                }
                let alert = NSAlert()
                alert.messageText = sameVersionDifferentCommit
                    ? label("GitHub main 有不同提交", "GitHub main has a different revision")
                    : label("发现 AgentReminder \(remoteVersion)", "AgentReminder \(remoteVersion) is available")
                alert.informativeText = label("安装后铃铛会自动重开。现有配对、联机设置和 hooks 会保留。",
                                              "The bell reopens automatically after installation. Pairings, Tailnet settings, and hooks are kept.")
                alert.addButton(withTitle: label("稍后", "Later"))
                alert.addButton(withTitle: label("安装更新", "Install update"))
                alert.addButton(withTitle: label("查看安装说明", "View installation instructions"))
                NSApp.activate(ignoringOtherApps: true)
                let response = alert.runModal()
                if response == .alertSecondButtonReturn {
                    await installUpdate(revision: revision)
                } else if response == .alertThirdButtonReturn,
                   let url = URL(string: "https://github.com/popomars/agentreminder/tree/\(revision)") {
                    NSWorkspace.shared.open(url)
                }
            } catch {
                showAlert(label("无法检查更新", "Could not check for updates"),
                          label("无法读取 GitHub 版本，请稍后重试。", "Could not read the GitHub version. Try again later."))
            }
        }
    }

    private func installUpdate(revision: String) async {
        guard !installingUpdate else { return }
        guard firmwareUpdate == nil, !pairing, !configuringCodex, !configuringTailnet,
              updatingHookAgents.isEmpty, inbox?.approvals.isEmpty != false else {
            showAlert(label("暂时无法安装更新", "Update is temporarily unavailable"),
                      label("请先完成当前操作和待审批事项，再重试。", "Finish active operations and pending approvals, then try again."))
            return
        }
        installingUpdate = true
        redraw()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentreminder-app-update-" + UUID().uuidString, isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
            installingUpdate = false
            redraw()
        }
        do {
            let data = try await fetchUpdateMetadata("contents/install.sh?ref=\(revision)", accept: "application/vnd.github.raw+json")
            guard data.starts(with: Data("#!/usr/bin/env bash\n".utf8)) else {
                throw URLError(.cannotDecodeContentData)
            }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            let script = directory.appendingPathComponent("install.sh")
            let log = directory.appendingPathComponent("install.log")
            try data.write(to: script)
            try Data().write(to: log)
            let result = try await runAppInstaller(script: script, log: log, revision: revision)
            if result != 0 {
                let file = try FileHandle(forReadingFrom: log)
                defer { try? file.close() }
                let end = try file.seekToEnd()
                try file.seek(toOffset: end > 4096 ? end - 4096 : 0)
                let details = String(decoding: try file.read(upToCount: 4096) ?? Data(), as: UTF8.self)
                    .split(whereSeparator: \.isNewline).suffix(8).joined(separator: "\n")
                showAlert(label("安装更新失败", "Could not install the update"),
                          details.isEmpty ? label("安装器已退出，请稍后重试。", "The installer exited. Try again later.") : details)
            }
        } catch {
            showAlert(label("安装更新失败", "Could not install the update"), error.localizedDescription)
        }
    }

    private func runAppInstaller(script: URL, log: URL, revision: String) async throws -> Int32 {
        let output = try FileHandle(forWritingTo: log)
        defer { try? output.close() }
        var environment = installation.processEnvironment
        if installation.usesDefaultStateDirectory { environment.removeValue(forKey: "AGENTREMINDER_HOME") }
        return try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            // The new app can replace this process's parent before Swift gets a completion callback.
            process.arguments = ["-c", """
                script=$1
                shift
                /bin/bash "$script" "$@"
                result=$?
                if [ "$result" -eq 0 ]; then rm -rf -- "${script%/*}"; fi
                exit "$result"
                """, "agentreminder-update", script.path, "--ref", revision,
                "--skip-hooks", "--no-pair", "--no-autostart", "--lang", installation.language]
            process.environment = environment
            process.standardOutput = output
            process.standardError = output
            process.terminationHandler = { completed in continuation.resume(returning: completed.terminationStatus) }
            do { try process.run() }
            catch { continuation.resume(throwing: error) }
        }
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

    private var canSetUpTailnet: Bool {
        inbox?.canInitializeTailnet == true && inbox?.tailnetConfigured == false && !configuringTailnet
    }

    private func addTailnetMenu() {
        let entry = action(label("联机服务", "Tailnet service"))
        let options = NSMenu(title: entry.title)
        options.autoenablesItems = false
        options.addItem(action(label("初始化…", "Initialize…"), #selector(initializeTailnet), enabled: canSetUpTailnet))
        options.addItem(action(label("加入联机服务…", "Join Tailnet service…"), #selector(joinTailnet), enabled: canSetUpTailnet))
        options.addItem(action(label("查看联机密钥…", "View shared key…"), #selector(showTailnetKey),
                               enabled: !configuringTailnet && installation.tailnetKey != nil))
        entry.submenu = options
        menu.addItem(entry)
    }

    @objc private func showTailnetKey() {
        guard !configuringTailnet, let key = installation.tailnetKey else { return }
        let alert = NSAlert()
        alert.messageText = label("联机密钥", "Tailnet shared key")
        alert.informativeText = inbox?.tailnetConfigured == true && inbox?.tailnetListening == false
            ? label("密钥已保存。请确认 Tailscale 已连接。", "The key is saved. Check that Tailscale is connected.")
            : label("其他 Mac 可以用这把密钥加入同一联机服务。",
                    "Use this key to join the same Tailnet service from another Mac.")
        alert.addButton(withTitle: label("完成", "Done"))
        alert.addButton(withTitle: label("复制密钥", "Copy key"))
        let field = NSTextField(labelWithString: key)
        field.isSelectable = true
        field.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        field.sizeToFit()
        alert.accessoryView = field
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn { _ = copyTailnetKey(key) }
    }

    private func copyTailnetKey(_ key: String) -> Bool {
        NSPasteboard.general.clearContents()
        return NSPasteboard.general.setString(key, forType: .string)
    }

    @objc private func initializeTailnet() {
        guard canSetUpTailnet else { return }
        let alert = NSAlert()
        alert.messageText = label("初始化联机服务", "Initialize Tailnet service")
        alert.informativeText = label("在第一台 Mac 生成并保存共享密钥。其他 Mac 可用这把密钥加入。",
                                      "Generate and save a shared key on the first Mac. Use it to join from the other Macs.")
        alert.addButton(withTitle: label("取消", "Cancel"))
        alert.addButton(withTitle: label("初始化", "Initialize"))
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        configureTailnet(.create)
    }

    @objc private func joinTailnet() {
        guard canSetUpTailnet else { return }
        let alert = NSAlert()
        alert.messageText = label("加入联机服务", "Join Tailnet service")
        alert.informativeText = label("粘贴已加入联机服务的 Mac 上的共享密钥。",
                                      "Paste the shared key from a Mac that has already joined.")
        let input = TailnetKeyField(frame: NSRect(x: 0, y: 0, width: 336, height: 26))
        alert.accessoryView = input
        alert.addButton(withTitle: label("取消", "Cancel"))
        alert.addButton(withTitle: label("加入", "Join"))
        alert.window.initialFirstResponder = input
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        configureTailnet(.join, key: input.stringValue)
    }

    private func configureTailnet(_ mode: TailnetSetupMode, key: String? = nil) {
        guard canSetUpTailnet else { return }
        configuringTailnet = true
        redraw()
        Task {
            defer { configuringTailnet = false; refresh(); redraw() }
            do {
                var setup = ["mode": mode.rawValue]
                setup["key"] = key
                let body = try JSONEncoder().encode(setup)
                let result: TailnetSetupResult = try await request("tailnet/setup", method: "POST", body: body)
                if result.ok == true {
                    if let latest: Inbox = try? await request("inbox") { inbox = latest }
                    let copied = mode == .create && installation.tailnetKey.map(copyTailnetKey) == true
                    let title = mode == .create ? label("联机服务已初始化", "Tailnet service initialized")
                                                : label("已加入联机服务", "Joined Tailnet service")
                    let message = copied
                        ? label("共享密钥已保存并复制。连接 Tailscale 后会自动发现同组电脑。",
                                "The shared key was saved and copied. Group members are discovered when Tailscale is connected.")
                        : label("共享密钥已保存在本机。连接 Tailscale 后会自动发现同组电脑。",
                                "The shared key is saved on this Mac. Group members are discovered when Tailscale is connected.")
                    showAlert(title, message)
                } else if result.error == "invalid-key" {
                    showAlert(label("共享密钥格式有误", "Invalid shared key"),
                              label("请粘贴 64 位十六进制密钥。", "Paste the 64-character hexadecimal key."))
                } else if result.error == "already-configured" {
                    showAlert(label("联机服务已配置", "Tailnet service is already configured"),
                              label("可从「联机服务 → 查看联机密钥」打开现有密钥。",
                                    "Open the current key under Tailnet service → View shared key."))
                } else {
                    throw URLError(.badServerResponse)
                }
            } catch {
                showAlert(label("无法配置联机服务", "Could not configure Tailnet service"),
                          label("请检查本机服务是否正常，再从铃铛重试。", "Check the local service and retry from the bell menu."))
            }
        }
    }

    private func integrationTitle(_ agent: AgentIntegration) -> String {
        switch agent {
        case .codex: return "Codex CLI"
        case .codexDesktop: return label("Codex 双端审批（桌面端）", "Codex Desktop approvals")
        case .claude: return "Claude Code"
        case .dsh: return "dsh"
        case .workbuddy: return "WorkBuddy"
        }
    }

    private func integrationStatusLabel(_ state: IntegrationStatus) -> String {
        switch state {
        case .enabled: return label("已启动", "Enabled")
        case .disabled: return label("已停用", "Disabled")
        case .unconfigured: return label("待配置", "Not configured")
        case .unavailable: return label("状态不可用", "Status unavailable")
        case .notInstalled: return label("未安装受支持的桌面端", "Supported app not installed")
        }
    }

    private func addAgentIntegrations() {
        let entry = action(label("Agent 接入", "Agent integrations"))
        let agents = NSMenu(title: entry.title)
        agents.autoenablesItems = false
        for agent in AgentIntegration.allCases {
            let name = integrationTitle(agent)
            let row = action(name)
            let options = NSMenu(title: name)
            options.autoenablesItems = false
            for enabled in [true, false] {
                let option = action(enabled ? label("启用", "Enable") : label("停用", "Disable"), #selector(toggleAgent(_:)))
                option.representedObject = AgentIntegration.Action(agent: agent, enabled: enabled)
                options.addItem(option)
            }
            if agent == .codexDesktop {
                options.addItem(.separator())
                options.addItem(action(label("选择桌面应用…", "Choose Desktop App…"), #selector(chooseCodexApp)))
            }
            let hint: String?
            switch agent {
            case .codex:
                hint = label("在终端运行 /hooks 审核并信任 AgentReminder", "Review and trust AgentReminder under /hooks in Codex")
            case .codexDesktop:
                hint = installation.codexApp == nil
                    ? nil
                    : label("更改后需要重新打开 ChatGPT", "Reopen ChatGPT after changing this setting")
            case .claude: hint = nil
            case .dsh: hint = label("需在 dsh profile 中加载 hooks 桥接", "Requires the hooks bridge in the dsh profile")
            case .workbuddy: hint = label("命令审批请回 WorkBuddy 确认", "Confirm command approvals in WorkBuddy")
            }
            if let hint {
                options.addItem(.separator())
                options.addItem(action(hint, enabled: false))
            }
            row.submenu = options
            updateAgentMenuItem(row, agent: agent)
            agents.addItem(row)
            if agent == .codexDesktop { codexMenuItem = row }
        }
        entry.submenu = agents
        menu.addItem(entry)
    }

    private func updateAgentMenuItem(_ row: NSMenuItem, agent: AgentIntegration) {
        let state: IntegrationStatus
        let ready: Bool
        let codexApp = agent == .codexDesktop ? installation.codexApp : nil
        if agent == .codexDesktop {
            state = codexApp == nil
                ? .notInstalled : codexDockStatus.map { $0.dockOverrideActive ? .enabled : .disabled } ?? .unavailable
            ready = !configuringCodex
        } else {
            state = inbox?.agentIntegrations?[agent.rawValue].flatMap(IntegrationStatus.init(rawValue:)) ?? .unavailable
            ready = inbox?.canManageIntegrations == true && !updatingHookAgents.contains(agent)
        }
        let status = agent == .codex && state == .enabled
            ? label("Hooks 已配置", "Hooks configured") : integrationStatusLabel(state)
        row.title = "\(integrationTitle(agent)) · \(status)"
        for option in row.submenu?.items ?? [] {
            if option.action == #selector(chooseCodexApp) {
                option.isEnabled = ready
                option.toolTip = codexApp?.path
            }
            guard let action = option.representedObject as? AgentIntegration.Action else { continue }
            option.state = state == (action.enabled ? .enabled : .disabled) ? .on : .off
            option.isEnabled = ready && (agent != .codexDesktop || !action.enabled || state != .notInstalled)
        }
    }

    @objc private func toggleAgent(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? AgentIntegration.Action else { return }
        if action.agent == .codexDesktop { configureCodex(enabled: action.enabled) }
        else { toggleHookAgent(action) }
    }

    private func toggleHookAgent(_ action: AgentIntegration.Action) {
        let agent = action.agent
        guard inbox?.canManageIntegrations == true, updatingHookAgents.insert(agent).inserted else { return }
        let name = integrationTitle(agent)
        let firstSetup = inbox?.agentIntegrations?[agent.rawValue] == "unconfigured"
        redraw()
        Task {
            defer { updatingHookAgents.remove(agent); refresh(); redraw() }
            do {
                let body = try JSONSerialization.data(withJSONObject: ["agent": agent.rawValue, "enabled": action.enabled])
                let result: AgentIntegrationResult = try await request("agent-integrations", method: "POST", body: body, timeout: 6)
                guard result.status == (action.enabled ? "enabled" : "disabled") else {
                    throw URLError(.badServerResponse)
                }
                if action.enabled && (result.installedHooks ?? firstSetup) {
                    let detail: String
                    switch agent {
                    case .codex:
                        detail = label("请重开 Codex，在终端输入 /hooks，审核并信任 AgentReminder 的 PermissionRequest 和 Stop。",
                                       "Reopen Codex, then review and trust the AgentReminder PermissionRequest and Stop hooks in /hooks.")
                    case .claude:
                        detail = label("Hooks 已写入。请开启新的 Claude Code 会话。", "Hooks are installed. Start a new Claude Code session.")
                    case .dsh:
                        detail = label("已生成 dsh-hooks.json。请在 dsh profile 中配置 Claude Code hooks 桥接。",
                                       "dsh-hooks.json is ready. Configure the Claude Code hooks bridge in your dsh profile.")
                    case .workbuddy:
                        detail = label("请重开 WorkBuddy。设备会收到任务完成通知和命令待确认提醒。",
                                       "Reopen WorkBuddy to receive task completions and command approval reminders on your device.")
                    case .codexDesktop: return
                    }
                    let status = agent == .codex ? label("Hooks 已配置", "Hooks configured") : integrationStatusLabel(.enabled)
                    showAlert("\(name) · \(status)", detail)
                }
            } catch {
                showAlert(label("无法更新 \(name) 接入", "Could not update \(name)"),
                          label("请检查本机服务和 Agent 的 hook 配置后重试。",
                                "Check the local service and the agent’s hook configuration, then try again."))
            }
        }
    }

    private func updateCodexMenuState() {
        if let codexMenuItem { updateAgentMenuItem(codexMenuItem, agent: .codexDesktop) }
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

    private func readCodexStatus(app: URL?) async -> CodexDockStatus? {
        guard let result = try? await runCodexSetup("status", app: app), result.exitCode == 0 else { return nil }
        return try? JSONDecoder().decode(CodexDockStatus.self, from: result.output)
    }

    private func refreshCodexStatus() {
        guard !configuringCodex else { return }
        let app = installation.codexApp
        codexStatusCheck?.cancel()
        codexStatusCheck = Task {
            let status = await readCodexStatus(app: app)
            guard !Task.isCancelled else { return }
            codexDockStatus = status
            updateCodexMenuState()
        }
    }

    @objc private func chooseCodexApp() {
        let picker = NSOpenPanel()
        picker.allowedContentTypes = [.applicationBundle]
        picker.message = label("选择包含 Codex 的桌面应用。", "Choose the desktop app that contains Codex.")
        picker.directoryURL = installation.codexApp?.deletingLastPathComponent()
        NSApp.activate(ignoringOtherApps: true)
        guard picker.runModal() == .OK, let app = picker.url else { return }
        guard installation.supportsCodexApp(app) else {
            showAlert(label("无法使用此应用", "This app is unsupported"),
                      label("请选择包含 Codex CLI 的 OpenAI 桌面应用。", "Choose an OpenAI desktop app with the bundled Codex CLI."))
            return
        }
        installation.selectCodexApp(app)
        if codexDockStatus?.dockOverrideActive == true { configureCodex(enabled: true) }
        else { refreshCodexStatus(); redraw() }
    }

    private func configureCodex(enabled: Bool) {
        guard !configuringCodex else { return }
        let app = installation.codexApp
        guard !enabled || app != nil else { return }
        let command = enabled ? "install" : "uninstall"
        configuringCodex = true
        codexStatusCheck?.cancel()
        updateCodexMenuState()
        Task {
            defer { configuringCodex = false; updateCodexMenuState() }
            do {
                let result = try await runCodexSetup(command, app: app)
                codexDockStatus = await readCodexStatus(app: app)
                updateCodexMenuState()
                guard result.exitCode == 0 else {
                    showAlert(label("无法更新 Codex 配置", "Could not update Codex setup"),
                              String(decoding: result.output, as: UTF8.self))
                    return
                }
                guard let app else { return }

                let restart = NSAlert()
                restart.messageText = "\(integrationTitle(.codexDesktop)) · \(integrationStatusLabel(enabled ? .enabled : .disabled))"
                restart.informativeText = label("重新打开 ChatGPT 后生效。可以稍后从 Dock 重开，或现在重启。退出可能中断正在运行的任务。",
                                                "The setting takes effect when ChatGPT reopens. Reopen it later from the Dock, or restart now. Quitting may interrupt running tasks.")
                restart.addButton(withTitle: label("稍后重开", "Reopen Later"))
                restart.addButton(withTitle: label("现在重启", "Restart Now"))
                NSApp.activate(ignoringOtherApps: true)
                if restart.runModal() == .alertSecondButtonReturn { try await restartCodex(app: app) }
            } catch {
                showAlert(label("无法完成 Codex 设置", "Could not complete Codex setup"), error.localizedDescription)
            }
        }
    }

    private func restartCodex(app: URL) async throws {
        let bundle = app.resolvingSymlinksInPath().standardizedFileURL
        let running = NSWorkspace.shared.runningApplications.filter {
            $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == bundle.path
        }
        for application in running { _ = application.terminate() }
        for _ in 0..<60 {
            if running.allSatisfy({ $0.isTerminated || (kill($0.processIdentifier, 0) == -1 && errno == ESRCH) }) {
                _ = try await NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
                return
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        showAlert(label("ChatGPT 仍在运行", "ChatGPT is still running"),
                  label("请处理 ChatGPT 的退出提示，或稍后从原来的 Dock 图标重开。设置已保存。",
                        "Handle any quit prompt in ChatGPT, or reopen it later from its usual Dock icon. The setting is already saved."))
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
