"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LivePreviewManager = void 0;
const vscode = __importStar(require("vscode"));
const browserSession_1 = require("../browser/browserSession");
const browserProfilePath_1 = require("../profile/browserProfilePath");
const url_1 = require("../utils/url");
class LivePreviewManager {
    context;
    workspaceState;
    selectionContextStore;
    panels = new Map();
    statusBar;
    outputChannel;
    lastActivePanelId;
    /**
     * Tracks the last focused text editor. We cannot use vscode.window.activeTextEditor
     * when handling element picks because the webview panel steals focus at click time,
     * making activeTextEditor === undefined. Instead we snapshot it on every change.
     */
    lastKnownEditor;
    editorTracker;
    cdpSession;
    cdpSessionPromise;
    cdpSessionRefCount = 0;
    constructor(context, workspaceState, selectionContextStore) {
        this.context = context;
        this.workspaceState = workspaceState;
        this.selectionContextStore = selectionContextStore;
        this.outputChannel = vscode.window.createOutputChannel("My Preview");
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this.statusBar.command = "myPreview.focus";
        this.statusBar.tooltip = "Focus the active Browser Workbench panel";
        this.statusBar.show();
        this.syncStatusBar();
        // Snapshot the active text editor whenever it changes.
        // This must happen before the webview grabs focus so we always have
        // a valid editor to insert picked element HTML into.
        this.lastKnownEditor = vscode.window.activeTextEditor;
        this.editorTracker = vscode.window.onDidChangeActiveTextEditor(editor => {
            // Only update when the NEW active editor is a real text editor (not undefined /
            // not the webview panel), so that we never clear the reference unnecessarily.
            if (editor) {
                this.lastKnownEditor = editor;
            }
        });
    }
    async open(rawUrl) {
        const fallbackUrl = this.getFallbackPreviewUrl();
        const reusable = this.getReusablePanel();
        if (reusable) {
            reusable.reveal();
            await reusable.navigateFromManager(rawUrl ?? fallbackUrl);
            return;
        }
        await this.createPanel(rawUrl ?? fallbackUrl, false);
    }
    async openInNewPanel(rawUrl, pinned = false) {
        const fallbackUrl = this.getFallbackPreviewUrl();
        await this.createPanel(rawUrl ?? fallbackUrl, pinned);
    }
    focusCurrent() {
        this.getLastActivePanel()?.reveal();
    }
    async pinCurrent() {
        const active = this.getLastActivePanel();
        if (!active) {
            void vscode.window.showInformationMessage("There is no active Browser Workbench panel to pin.");
            return;
        }
        active.togglePinned();
    }
    async goBack() {
        this.getLastActivePanel()?.sendCommand("browser.goBack");
    }
    async goForward() {
        this.getLastActivePanel()?.sendCommand("browser.goForward");
    }
    async reload(ignoreCache = false) {
        this.getLastActivePanel()?.sendCommand("browser.reload");
    }
    async copyUrl() {
        await this.getLastActivePanel()?.copyUrl();
    }
    async openExternal() {
        await this.getLastActivePanel()?.openExternal();
    }
    async togglePickMode() {
        this.getLastActivePanel()?.sendCommand("browser.togglePickMode");
    }
    async copyContextForAi() {
        // No-op in iframe mode (no CDP element pinning)
    }
    async clearSelections() {
        this.selectionContextStore.clear();
    }
    /**
     * Insert selected element HTML/info at the last known text editor cursor position.
     *
     * We deliberately use `lastKnownEditor` instead of `vscode.window.activeTextEditor`
     * because clicking inside the browser webview to pick an element causes VS Code to
     * switch the active editor to `undefined` (the webview), so `activeTextEditor` is
     * always null by the time the pick message arrives.
     */
    async insertAtEditorCursor(content) {
        // Prefer the current active editor; fall back to the last known one.
        const editor = vscode.window.activeTextEditor ?? this.lastKnownEditor;
        if (!editor) {
            await vscode.env.clipboard.writeText(content);
            vscode.window.showInformationMessage('Element HTML copied to clipboard (no text editor was open when you picked the element).');
            return;
        }
        const success = await editor.edit(editBuilder => {
            for (const selection of editor.selections) {
                if (!selection.isEmpty) {
                    editBuilder.replace(selection, content);
                }
                else {
                    editBuilder.insert(selection.active, content);
                }
            }
        });
        if (success) {
            vscode.window.setStatusBarMessage('$(code) Element HTML inserted at cursor', 2500);
        }
        else {
            // Editor might be read-only – fall back to clipboard
            await vscode.env.clipboard.writeText(content);
            vscode.window.showInformationMessage('Editor is read-only — element HTML copied to clipboard instead.');
        }
    }
    hasOpenPanel() {
        return this.panels.size > 0;
    }
    getCurrentUrl() {
        return this.getLastActivePanel()?.currentUrl;
    }
    getSelectionContext() {
        return this.selectionContextStore.getSelections();
    }
    trace(message, data) {
        const configuration = vscode.workspace.getConfiguration("myPreview");
        if (!configuration.get("debugLogging", false)) {
            return;
        }
        this.outputChannel.appendLine(formatDiagnosticLine(message, data));
    }
    async showDiagnostics() {
        const active = this.getLastActivePanel();
        this.outputChannel.show(true);
        this.outputChannel.appendLine("");
        this.outputChannel.appendLine(`--- My Preview diagnostics ${new Date().toISOString()} ---`);
        this.outputChannel.appendLine(`Active panel URL: ${active?.currentUrl ?? "<none>"}`);
        this.outputChannel.appendLine(`Panel visible: ${active ? String(active.visible) : "<none>"}`);
        this.outputChannel.appendLine(`Panel last frame: ${JSON.stringify(active?.lastFrameDiagnostic ?? null)}`);
        if (!this.cdpSession) {
            this.outputChannel.appendLine("CDP session: <not created>");
            return;
        }
        try {
            const state = await this.cdpSession.getNavigationState();
            this.outputChannel.appendLine(`CDP URL: ${state.currentUrl}`);
            this.outputChannel.appendLine(`CDP title: ${state.title}`);
        }
        catch (error) {
            this.outputChannel.appendLine(`CDP navigation state error: ${formatError(error)}`);
        }
        try {
            const page = await this.cdpSession.evaluateJson(`(() => ({
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyTextLength: document.body ? document.body.innerText.length : 0,
        background: getComputedStyle(document.body || document.documentElement).backgroundColor,
        visibility: document.visibilityState
      }))()`);
            this.outputChannel.appendLine(`DOM snapshot: ${JSON.stringify(page ?? null)}`);
        }
        catch (error) {
            this.outputChannel.appendLine(`DOM snapshot error: ${formatError(error)}`);
        }
        try {
            const shot = await this.cdpSession.captureScreenshot();
            this.outputChannel.appendLine(`Screenshot: ${shot.width}x${shot.height}, dataUrlLength=${shot.dataUrl.length}, prefix=${shot.dataUrl.slice(0, 23)}`);
        }
        catch (error) {
            this.outputChannel.appendLine(`Screenshot error: ${formatError(error)}`);
        }
    }
    /* ── Bridge/MCP API (uses CDP session lazily) ── */
    async bridgeNavigate(url) {
        const panel = this.getLastActivePanel();
        if (panel) {
            await panel.navigateFromManager(url);
            return;
        }
        const session = await this.ensureCdpSession();
        await session.navigate(url);
    }
    async bridgeScreenshot() {
        const session = await this.ensureCdpSession();
        const shot = await session.captureScreenshot();
        const match = shot.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
            throw new Error("Screenshot capture returned an unexpected format.");
        }
        return { mime: match[1], base64: match[2] };
    }
    async bridgeGetDom() {
        const session = await this.ensureCdpSession();
        return session.getDocumentHtml();
    }
    async bridgeClick(x, y) {
        const session = await this.ensureCdpSession();
        await session.clickPoint(x, y);
    }
    async bridgeGetCurrentUrl() {
        return this.getLastActivePanel()?.currentUrl;
    }
    dispose() {
        for (const panel of this.panels.values()) {
            panel.dispose();
        }
        if (this.cdpSession) {
            void this.cdpSession.close().catch(() => undefined);
            this.cdpSession = undefined;
            this.cdpSessionPromise = undefined;
        }
        this.editorTracker.dispose();
        this.statusBar.dispose();
        this.outputChannel.dispose();
    }
    getReusablePanel() {
        const active = this.getLastActivePanel();
        if (active && !active.pinned) {
            return active;
        }
        return [...this.panels.values()].find((panel) => !panel.pinned);
    }
    getLastActivePanel() {
        return this.lastActivePanelId ? this.panels.get(this.lastActivePanelId) : undefined;
    }
    getFallbackPreviewUrl() {
        const lastUrl = this.workspaceState.getLastPreviewUrl();
        return lastUrl && !isBlankPageUrl(lastUrl) ? lastUrl : "http://localhost:3000";
    }
    async ensureCdpSession() {
        if (this.cdpSession) {
            return this.cdpSession;
        }
        if (this.cdpSessionPromise) {
            return this.cdpSessionPromise;
        }
        const configuration = vscode.workspace.getConfiguration("myPreview");
        const usePersistentProfile = configuration.get("persistUserDataDir", false);
        let userDataDir;
        let persistUserDataDir = false;
        if (usePersistentProfile) {
            userDataDir = await (0, browserProfilePath_1.ensureBrowserProfileDirectory)(this.context);
            persistUserDataDir = true;
        }
        const browserConfig = {
            executablePath: configuration.get("browserExecutablePath", "").trim() || undefined,
            viewport: {
                width: configuration.get("viewportWidth", 1440),
                height: configuration.get("viewportHeight", 900),
                deviceScaleFactor: 1,
            },
            screenshotFormat: configuration.get("screenshotFormat", "jpeg"),
            jpegQuality: configuration.get("jpegQuality", 82),
            userDataDir,
            persistUserDataDir,
        };
        this.cdpSessionPromise = browserSession_1.BrowserSession.create(browserConfig)
            .then((session) => {
            this.cdpSession = session;
            return session;
        })
            .catch((error) => {
            this.cdpSessionPromise = undefined;
            throw error;
        });
        return this.cdpSessionPromise;
    }
    async createPanel(initialUrl, pinned) {
        const panelId = `preview-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const portMappings = buildPortMappings(initialUrl);
        const panel = vscode.window.createWebviewPanel("myPreview.browserWorkbench", "Browser Workbench", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
            enableScripts: true,
            enableForms: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
            portMapping: portMappings,
        });
        const controller = new LivePreviewPanelController(panelId, panel, this.context, this.workspaceState, initialUrl, pinned, this, () => {
            this.lastActivePanelId = panelId;
            this.syncStatusBar();
        }, async (snapshot) => {
            this.lastActivePanelId = panelId;
            await this.workspaceState.setLastPreviewUrl(snapshot.url);
            await this.workspaceState.upsertPanelSnapshot(snapshot);
            this.syncStatusBar();
        }, async (disposedPanelId) => {
            this.panels.delete(disposedPanelId);
            this.syncStatusBar();
        }, this.ensureCdpSession.bind(this), this.trace.bind(this));
        this.panels.set(panelId, controller);
        this.lastActivePanelId = panelId;
        this.syncStatusBar();
    }
    syncStatusBar() {
        const active = this.getLastActivePanel();
        const activeUrl = active?.currentUrl;
        this.statusBar.text = activeUrl
            ? `Browser: ${(0, url_1.hostnameLabel)(activeUrl)}`
            : "Browser: idle";
    }
}
exports.LivePreviewManager = LivePreviewManager;
class LivePreviewPanelController {
    id;
    panel;
    context;
    workspaceState;
    manager;
    onFocused;
    onSnapshot;
    onDisposed;
    getContextSession;
    trace;
    disposed = false;
    currentUrl = "";
    pinned;
    constructor(id, panel, context, workspaceState, initialUrl, pinned, manager, onFocused, onSnapshot, onDisposed, getContextSession, trace) {
        this.id = id;
        this.panel = panel;
        this.context = context;
        this.workspaceState = workspaceState;
        this.manager = manager;
        this.onFocused = onFocused;
        this.onSnapshot = onSnapshot;
        this.onDisposed = onDisposed;
        this.getContextSession = getContextSession;
        this.trace = trace;
        this.pinned = pinned;
        this.currentUrl = initialUrl;
        this.awaitingNavigationCommit = Boolean(initialUrl && !isBlankPageUrl(initialUrl));
        this.panel.webview.html = this.renderHtml(this.panel.webview, initialUrl);
        this.panel.onDidDispose(() => {
            this.disposed = true;
            void this.onDisposed(this.id);
        });
        this.panel.onDidChangeViewState((event) => {
            if (event.webviewPanel.active) {
                this.onFocused();
            }
        });
        this.panel.webview.onDidReceiveMessage((message) => {
            void this.handleMessage(message);
        });
        void this.pollLoop();
    }
    polling = false;
    pickMode = false;
    pickerInjected = false;
    pickerUnsubscribe;
    awaitingNavigationCommit = false;
    lastFrameDiagnostic;
    get visible() {
        return this.panel.visible;
    }
    async pollLoop() {
        if (this.polling)
            return;
        this.polling = true;
        let captureErrorShown = false;
        // Ensure browser is navigated before starting to capture screenshots
        if (this.currentUrl) {
            try {
                const session = await this.getContextSession();
                this.trace("navigate.initial.start", { url: this.currentUrl });
                await session.navigate(this.currentUrl);
                const state = await session.getNavigationState();
                this.trace("navigate.initial.done", state);
                this.applyNavigationState(state);
            }
            catch (e) {
                this.trace("navigate.initial.error", { url: this.currentUrl, error: formatError(e) });
                this.postToWebview("browser.state", {
                    error: `Failed to load ${this.currentUrl}: ${e instanceof Error ? e.message : String(e)}`
                });
            }
        }
        let screenshotCount = 0;
        while (!this.disposed) {
            if (this.panel.visible) {
                try {
                    screenshotCount++;
                    const session = await this.getContextSession();
                    if (this.awaitingNavigationCommit) {
                        const state = await session.getNavigationState();
                        const didCommit = this.applyNavigationState(state);
                        if (!didCommit) {
                            if (screenshotCount % 30 === 0) {
                                this.trace("navigate.waitingForCommit", state);
                            }
                            await new Promise(r => setTimeout(r, Math.floor(1000 / 30)));
                            continue;
                        }
                    }
                    const shot = await session.captureScreenshot();
                    if (shot && shot.dataUrl && shot.dataUrl.startsWith('data:')) {
                        this.postToWebview("browser.screenshot", shot);
                        if (captureErrorShown) {
                            captureErrorShown = false;
                            this.postToWebview("browser.state", {});
                        }
                    }
                    // Sync URL back to UI periodically (e.g., every 15 frames = ~0.5s) to catch redirects/SPAs
                    if (screenshotCount % 15 === 0) {
                        this.applyNavigationState(await session.getNavigationState());
                    }
                }
                catch (e) {
                    if (!captureErrorShown) {
                        this.trace("capture.error", { currentUrl: this.currentUrl, error: formatError(e) });
                        captureErrorShown = true;
                        this.postToWebview("browser.state", {
                            error: `Preview capture failed: ${e instanceof Error ? e.message : String(e)}`
                        });
                    }
                }
            }
            await new Promise(r => setTimeout(r, Math.floor(1000 / 30)));
        }
    }
    reveal() {
        this.panel.reveal(vscode.ViewColumn.Beside, false);
    }
    dispose() {
        this.panel.dispose();
    }
    navigateViaMessage(url) {
        this.postToWebview("browser.navigate", { url });
    }
    async navigateFromManager(url) {
        await this.handleMessage({ type: "browser.navigate", payload: { url } });
    }
    sendCommand(type) {
        this.postToWebview(type);
    }
    postToWebview(type, payload) {
        if (this.disposed) {
            return;
        }
        try {
            void this.panel.webview.postMessage({ type, payload }).then(undefined, (error) => {
                this.trace("webview.postMessage.error", { type, error: formatError(error) });
            });
        }
        catch (error) {
            this.trace("webview.postMessage.error", { type, error: formatError(error) });
        }
    }
    togglePinned() {
        this.pinned = !this.pinned;
        this.updateTitle();
        void this.snapshot();
    }
    async copyUrl() {
        if (!this.currentUrl)
            return;
        await vscode.env.clipboard.writeText(this.currentUrl);
    }
    async openExternal() {
        if (!this.currentUrl)
            return;
        await vscode.env.openExternal(vscode.Uri.parse(this.currentUrl));
    }
    async handleMessage(message) {
        const payload = message.payload || {};
        switch (message.type) {
            case "browser.ready":
                break;
            case "browser.navigate":
                if (payload && payload.url) {
                    try {
                        const { url, warnings } = (0, url_1.validatePreviewUrl)(String(payload.url), this.getSecuritySettings());
                        const normalizedUrl = url.toString();
                        this.currentUrl = normalizedUrl;
                        this.awaitingNavigationCommit = !isBlankPageUrl(normalizedUrl);
                        this.updateTitle();
                        void this.snapshot();
                        this.trace("navigate.request", { url: normalizedUrl });
                        this.postToWebview("browser.navigate", { url: normalizedUrl });
                        this.postToWebview("browser.state", warnings.length > 0 ? { warning: warnings.join(" ") } : {});
                        const session = await this.getContextSession();
                        await session.navigate(normalizedUrl);
                        const state = await session.getNavigationState();
                        this.trace("navigate.done", state);
                        this.applyNavigationState(state);
                    }
                    catch (e) {
                        this.trace("navigate.error", { requestedUrl: payload.url, error: formatError(e) });
                        this.postToWebview("browser.state", {
                            error: `Navigation failed: ${e instanceof Error ? e.message : String(e)}`
                        });
                    }
                }
                break;
            case "browser.reload":
                try {
                    const session = await this.getContextSession();
                    await session.reload();
                }
                catch (e) { }
                break;
            case "browser.hardReload":
                try {
                    const session = await this.getContextSession();
                    await session.reload(true);
                }
                catch (e) { }
                break;
            case "browser.goBack":
                try {
                    const session = await this.getContextSession();
                    await session.goBack();
                }
                catch (e) { }
                break;
            case "browser.goForward":
                try {
                    const session = await this.getContextSession();
                    await session.goForward();
                }
                catch (e) { }
                break;
            case "browser.didNavigate": {
                const url = typeof payload.url === "string" ? payload.url : "";
                if (url && !isBlankPageUrl(url)) {
                    this.currentUrl = url;
                    this.awaitingNavigationCommit = !isBlankPageUrl(url);
                    this.updateTitle();
                    void this.snapshot();
                }
                else if (url) {
                    this.trace("webview.didNavigate.ignoredBlank", { url });
                }
                break;
            }
            case "browser.titleChanged": {
                const title = typeof payload.title === "string" ? payload.title : "";
                if (title && !isBlankPageTitle(title)) {
                    this.updateTitle(title);
                }
                else if (title) {
                    this.trace("webview.titleChanged.ignoredBlank", { title });
                }
                break;
            }
            case "browser.frameLoaded": {
                this.lastFrameDiagnostic = payload;
                this.trace("webview.frameLoaded", this.lastFrameDiagnostic);
                break;
            }
            case "browser.copyUrl":
                await this.copyUrl();
                break;
            case "browser.togglePickMode": {
                const nowActive = Boolean(payload?.active);
                this.pickMode = nowActive;
                if (nowActive) {
                    await this.injectPickerScript();
                }
                else {
                    await this.removePickerScript();
                }
                break;
            }
            case "browser.keydown":
                if (payload?.key) {
                    try {
                        const session = await this.getContextSession();
                        await session.sendKey("keyDown", String(payload.key), payload.text ? String(payload.text) : undefined);
                        if (payload.text) {
                            await session.sendKey("char", String(payload.key), String(payload.text));
                        }
                    }
                    catch (e) { }
                }
                break;
            case "browser.keyup":
                if (payload?.key) {
                    try {
                        const session = await this.getContextSession();
                        await session.sendKey("keyUp", String(payload.key));
                    }
                    catch (e) { }
                }
                break;
            case "browser.mousemove":
                if (this.pickMode && payload) {
                    try {
                        const session = await this.getContextSession();
                        const { backendNodeId } = await session.send("DOM.getNodeForLocation", { x: Number(payload.x), y: Number(payload.y), includeUserAgentShadowDOM: true });
                        if (backendNodeId) {
                            const model = await session.send("DOM.getBoxModel", { backendNodeId });
                            const node = await session.send("DOM.describeNode", { backendNodeId });
                            this.postToWebview("browser.inspectHover", { box: model.model.border, node: node.node });
                        }
                    }
                    catch (e) { }
                }
                else if (payload) {
                    try {
                        const session = await this.getContextSession();
                        await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(payload.x), y: Number(payload.y), button: "none" });
                    }
                    catch (e) { }
                }
                break;
            case "browser.click":
                // In pick mode, clicks are intercepted by the injected script inside the page.
                // We only forward clicks to CDP when NOT in pick mode.
                if (!this.pickMode && payload) {
                    try {
                        const session = await this.getContextSession();
                        await session.clickPoint(Number(payload.x), Number(payload.y));
                    }
                    catch (e) { }
                }
                break;
            case "browser.elementPicked": {
                // Message received from the injected picker script via CDP binding callback.
                // Unsubscribe the listener regardless of outcome.
                this.pickerUnsubscribe?.();
                this.pickerUnsubscribe = undefined;
                const cancelled = Boolean(payload?.cancelled);
                const html = typeof payload?.outerHTML === "string" ? payload.outerHTML : "";
                const tag = typeof payload?.tag === "string" ? payload.tag : "element";
                if (!cancelled && html) {
                    await this.manager.insertAtEditorCursor(html);
                    vscode.window.setStatusBarMessage(`$(code) Picked <${tag}> — HTML inserted at cursor`, 3000);
                }
                // Exit pick mode
                this.pickMode = false;
                this.pickerInjected = false;
                this.postToWebview("browser.togglePickMode", { active: false });
                this.postToWebview("browser.inspectHover", null);
                break;
            }
            case "browser.wheel":
                if (payload) {
                    try {
                        const session = await this.getContextSession();
                        await session.scrollBy(Number(payload.deltaX), Number(payload.deltaY));
                    }
                    catch (e) { }
                }
                break;
            case "browser.clearCache":
                try {
                    const session = await this.getContextSession();
                    await session.clearCache();
                }
                catch (e) { }
                break;
            case "browser.clearCookies":
                try {
                    const session = await this.getContextSession();
                    await session.clearCookies();
                }
                catch (e) { }
                break;
            case "browser.setZoom":
                try {
                    const session = await this.getContextSession();
                    await session.setZoom(Number(payload?.scale ?? 1));
                }
                catch (e) { }
                break;
            case "browser.resize":
                try {
                    if (payload && payload.width && payload.height) {
                        const session = await this.getContextSession();
                        await session.updateViewport(Number(payload.width), Number(payload.height));
                    }
                }
                catch (e) { }
                break;
            case "webview.ready":
                break;
            case "cursor.bridge":
                break;
            case "browser.updateStyle":
                try {
                    if (payload?.selector && payload?.property !== undefined && payload?.value !== undefined) {
                        const session = await this.getContextSession();
                        const script = `
                   const element = document.querySelector('${payload.selector}');
                   if (element) {
                     element.style.${payload.property} = '${payload.value}';
                   }
                 `;
                        await session.send("Runtime.evaluate", { expression: script });
                    }
                }
                catch (e) { }
                break;
            case "browser.contextmenu":
                break;
            case "browser.newTab":
                try {
                    const lastUrl = this.workspaceState.getLastPreviewUrl();
                    const newUrl = lastUrl && !isBlankPageUrl(lastUrl) ? lastUrl : "http://localhost:3000";
                    this.postToWebview("browser.navigate", { url: newUrl });
                }
                catch (e) { }
                break;
            case "browser.closeTab":
                try {
                    this.panel.dispose();
                }
                catch (e) { }
                break;
            case "browser.toggleSidebar":
                try {
                    await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
                }
                catch (e) { }
                break;
            case "browser.selectAll":
                try {
                    const session = await this.getContextSession();
                    await session.send("Runtime.evaluate", {
                        expression: "document.execCommand('selectAll')"
                    });
                }
                catch (e) { }
                break;
            case "browser.toggleBookmark":
                break;
            case "browser.takeScreenshot":
                try {
                    const session = await this.getContextSession();
                    const shot = await session.captureScreenshot();
                    if (shot?.dataUrl) {
                        this.postToWebview("browser.areaScreenshot", { dataUrl: shot.dataUrl, clip: null });
                    }
                }
                catch (e) {
                    console.error('[LivePreview] Take screenshot failed:', e);
                }
                break;
            case "browser.clearBrowsingHistory":
                try {
                    const session = await this.getContextSession();
                    await session.clearBrowsingHistory(this.currentUrl);
                }
                catch (e) { }
                break;
            case "browser.captureArea":
                try {
                    // Capture specific area by element selector or bounding box
                    const session = await this.getContextSession();
                    let clip;
                    if (payload?.selector) {
                        // Get bounding box of specified element
                        const expr = `(() => {
              const el = document.querySelector(${JSON.stringify(String(payload.selector))});
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            })()`;
                        const res = await session.send("Runtime.evaluate", { expression: expr, returnByValue: true });
                        const box = res?.result?.value;
                        if (box && box.width > 0 && box.height > 0) {
                            clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
                        }
                    }
                    else if (payload?.x !== undefined && payload?.width !== undefined) {
                        // Direct bounding box provided
                        clip = { x: Number(payload.x), y: Number(payload.y), width: Number(payload.width), height: Number(payload.height), scale: 1 };
                    }
                    const format = "png"; // PNG for area crops preserves quality
                    const params = { format, captureBeyondViewport: false };
                    if (clip) {
                        params.clip = clip;
                    }
                    const resp = await session.send("Page.captureScreenshot", params);
                    if (resp?.data) {
                        const dataUrl = `data:image/png;base64,${resp.data}`;
                        this.postToWebview("browser.areaScreenshot", { dataUrl, clip });
                    }
                }
                catch (e) {
                    console.error('[LivePreview] Area capture failed:', e);
                }
                break;
            default:
                break;
        }
    }
    // ── Manus-style element picker ────────────────────────────────────────────
    /**
     * Injects a lightweight highlight + click-intercept script into the live
     * browser page via CDP Runtime.evaluate.  The script:
     *  - Draws a blue overlay div over whichever element the mouse is over
     *  - Shows a small label tooltip (tag, id/class, dimensions)
     *  - On click: prevents default, collects outerHTML + selector, then calls
     *    window.__vscodePicker(payload) which we bridge back via a CDP binding.
     */
    async injectPickerScript() {
        if (this.pickerInjected)
            return;
        try {
            const session = await this.getContextSession();
            // 1. Register a named binding so the page can call back into the extension.
            //    Chrome DevTools Protocol: Runtime.addBinding exposes a global
            //    window.__vscodePicker(jsonString) function inside the page.
            await session.send("Runtime.addBinding", { name: "__vscodePicker" });
            // 2. Listen for the binding call event (fires when the page calls the function).
            //    We register only once; the binding auto-disposes when the page navigates.
            this.pickerUnsubscribe?.(); // clean up any previous listener
            this.pickerUnsubscribe = session.onCdpEvent("Runtime.bindingCalled", (params) => {
                const event = params;
                if (event.name !== "__vscodePicker")
                    return;
                try {
                    const data = JSON.parse(event.payload ?? "{}");
                    void this.handleMessage({ type: "browser.elementPicked", payload: data });
                }
                catch { /* malformed payload */ }
            });
            // 3. Inject the picker UI script using the bundled pick-dom-element package.
            const { PICKER_SCRIPT } = require("../browser/pickerScript");
            await session.send("Runtime.evaluate", { expression: PICKER_SCRIPT });
            await session.send("Runtime.evaluate", { expression: "window.StartVsCodePicker()" });
            this.pickerInjected = true;
            this.postToWebview("browser.pickMode", { active: true });
        }
        catch (e) {
            console.error("[LivePreview] Failed to inject picker:", e);
        }
    }
    /**
     * Removes the picker overlay from the live browser page and resets cursor.
     */
    async removePickerScript() {
        if (!this.pickerInjected)
            return;
        this.pickerInjected = false;
        try {
            const session = await this.getContextSession();
            await session.send("Runtime.evaluate", {
                expression: "if (typeof window.StopVsCodePicker === 'function') window.StopVsCodePicker();"
            });
        }
        catch { /* page may have navigated */ }
    }
    async snapshot() {
        if (!this.currentUrl)
            return;
        await this.workspaceState.setLastPreviewUrl(this.currentUrl);
        await this.onSnapshot({
            id: this.id,
            url: this.currentUrl,
            pinned: this.pinned,
        });
    }
    updateTitle(pageTitle) {
        const host = this.currentUrl ? (0, url_1.hostnameLabel)(this.currentUrl) : "browser";
        const label = pageTitle || host;
        this.panel.title = this.pinned ? `${label} (Pinned)` : label;
    }
    applyNavigationState(state) {
        if (!state.currentUrl || isBlankPageUrl(state.currentUrl)) {
            return false;
        }
        this.awaitingNavigationCommit = false;
        if (state.currentUrl !== this.currentUrl) {
            this.trace("navigationState.urlChanged", { from: this.currentUrl, to: state.currentUrl, title: state.title });
            this.currentUrl = state.currentUrl;
            this.updateTitle(isBlankPageTitle(state.title) ? undefined : state.title);
            void this.snapshot();
            this.postToWebview("browser.navigate", { url: this.currentUrl });
            return true;
        }
        if (state.title && !isBlankPageTitle(state.title)) {
            this.updateTitle(state.title);
        }
        else {
            this.updateTitle();
        }
        return true;
    }
    getSecuritySettings() {
        const configuration = vscode.workspace.getConfiguration("myPreview");
        return {
            allowLocalhost: configuration.get("allowLocalhost", true),
            allowPrivateHosts: configuration.get("allowPrivateHosts", false),
            allowedHosts: configuration
                .get("allowedHosts", [])
                .map((host) => host.trim().toLowerCase())
                .filter(Boolean),
        };
    }
    renderHtml(webview, initialUrl) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "browserWorkbench.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "browserWorkbench.css"));
        const nonce = createNonce();
        const escapedUrl = initialUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src http: https: ${webview.cspSource}; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src data: http: https:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Browser</title>
  </head>
  <body>
    <div class="shell">
      <header class="toolbar">
        <div class="nav-group">
          <button id="backButton" title="Back" class="icon-btn" aria-label="Back"><svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M5.928 7.976l4.357-4.357-.618-.62L5 7.671v.61l4.667 4.672.618-.62-4.357-4.357z"/></svg></button>
          <button id="forwardButton" title="Forward" class="icon-btn" aria-label="Forward"><svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M10.072 7.976L5.715 3.619l.618-.62L11 7.671v.61l-4.667 4.672-.618-.62 4.357-4.357z"/></svg></button>
          <button id="reloadButton" title="Reload" class="icon-btn" aria-label="Reload"><svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-2.64l-.47.85A6 6 0 1 1 4.681 3z"/></svg></button>
        </div>
        <div class="url-bar">
          <input id="urlInput" type="text" value="${escapedUrl}" placeholder="Enter URL" spellcheck="false" />
        </div>
        <div class="actions-group">
          <!-- Cursor-style inline action icons -->
          <button id="pickButton" title="Pick Element — click an element to insert its HTML at your editor cursor" class="icon-btn" aria-label="Pick Element">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3.5 2L13.5 8.5L8.5 9.5L6 14L3.5 2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/>
              <circle cx="13" cy="3" r="1.5" fill="currentColor" opacity="0.5"/>
            </svg>
          </button>
          <button id="screenshotButton" title="Take Screenshot" class="icon-btn" aria-label="Take Screenshot">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1" y="3.5" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/>
              <circle cx="8" cy="8.5" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/>
              <rect x="5.5" y="1.5" width="5" height="2" rx="0.5" stroke="currentColor" stroke-width="1" fill="none"/>
              <circle cx="8" cy="8.5" r="1" fill="currentColor"/>
            </svg>
          </button>
          <button id="captureAreaButton" title="Capture Area — drag to select a region to screenshot" class="icon-btn" aria-label="Capture Area">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 4V2h2M12 2h2v2M14 12v2h-2M4 14H2v-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
              <rect x="4" y="4" width="8" height="8" rx="0.5" stroke="currentColor" stroke-width="1" stroke-dasharray="2 1.5" fill="none"/>
            </svg>
          </button>
          <div class="separator"></div>
          <div style="position:relative">
            <button id="moreButton" type="button" class="icon-btn" title="More Actions\u2026" aria-label="More Actions"><svg width="16" height="16" viewBox="0 0 16 16"><circle fill="currentColor" cx="3.5" cy="8" r="1.5"/><circle fill="currentColor" cx="8" cy="8" r="1.5"/><circle fill="currentColor" cx="12.5" cy="8" r="1.5"/></svg></button>
            <div id="moreMenu" class="dropdown-menu hidden">
              <button id="menuToggleDevTools" class="dropdown-item">Developer Tools</button>
              <button id="menuToggleCssInspector" class="dropdown-item">CSS Inspector</button>
              <button id="menuToggleSidebar" class="dropdown-item">Toggle Sidebar</button>
              <button id="menuToggleTerminal" class="dropdown-item">Toggle Terminal</button>
              <div class="dropdown-divider"></div>
              <button id="menuHardReload" class="dropdown-item">Hard Reload</button>
              <button id="menuCopyUrl" class="dropdown-item">Copy Current URL</button>
              <div class="dropdown-divider"></div>
              <div class="dropdown-row">
                <span>Zoom</span>
                <div class="zoom-controls">
                  <button id="zoomOut" class="zoom-btn">\u2212</button>
                  <span id="zoomLevel">100%</span>
                  <button id="zoomIn" class="zoom-btn">+</button>
                  <button id="zoomReset" class="zoom-btn" title="Reset Zoom"><svg width="12" height="12" viewBox="0 0 16 16"><path fill="currentColor" d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-2.64l-.47.85A6 6 0 1 1 4.681 3z"/></svg></button>
                </div>
              </div>
              <div class="dropdown-divider"></div>
              <button id="menuClearHistory" class="dropdown-item">Clear Browsing History</button>
              <button id="menuClearCookies" class="dropdown-item">Clear Cookies</button>
              <button id="menuClearCache" class="dropdown-item">Clear Cache</button>
            </div>
          </div>
        </div>
      </header>
      <div id="messageBar" class="message-bar hidden"></div>
      <div id="selectionsBar" class="selections-bar hidden">
        <div class="selections-header">
          <span class="selections-title">Selected Elements</span>
          <button id="clearSelections" class="selections-clear" title="Clear all">&times;</button>
        </div>
        <div id="selectionsList" class="selections-list"></div>
      </div>
      <div id="stage" class="stage">
        <div id="emptyState" class="empty-state hidden">Enter a URL to start browsing.</div>
        <img
          id="browserFrame"
          draggable="false"
        />
        <div id="inspectHoverBox" class="inspect-hover-box hidden"></div>
        <div id="inspectTooltip" class="inspect-tooltip hidden"></div>
        
        <!-- Cursor-style Element Selector -->
        <div id="elementSelector" class="element-selector hidden">
          <div class="element-selector-info" id="elementSelectorInfo">No element selected</div>
          <div class="element-selector-actions">
            <button id="elementSelectBtn" class="element-selector-btn">Select</button>
            <button id="elementInspectBtn" class="element-selector-btn">Inspect</button>
            <button id="elementCopyBtn" class="element-selector-btn">Copy</button>
          </div>
        </div>
        
        <!-- Cursor-style CSS Inspector -->
        <div id="cssInspector" class="css-inspector">
          <div class="css-inspector-header">
            <span class="css-inspector-title">CSS Inspector (Hide via Menu)</span>
            <button id="cssInspectorClose" class="css-inspector-close">×</button>
          </div>
          <div class="css-inspector-content" id="cssInspectorContent">
            <!-- CSS properties will be populated here -->
          </div>
          <div class="css-inspector-actions">
            <button id="cssInspectorApply" class="css-inspector-btn">Apply Changes</button>
            <button id="cssInspectorReset" class="css-inspector-btn secondary">Reset</button>
            <button id="cssInspectorUndo" class="css-inspector-btn secondary">Undo</button>
            <button id="cssInspectorRedo" class="css-inspector-btn secondary">Redo</button>
          </div>
        </div>
        
        <!-- Cursor-style Dev Tools -->
        <div id="devTools" class="dev-tools">
          <div class="dev-tools-header">
            <div class="dev-tools-tabs">
              <button class="dev-tools-tab active" data-tab="console">Console</button>
              <button class="dev-tools-tab" data-tab="network">Network</button>
              <button class="dev-tools-tab" data-tab="elements">Elements</button>
            </div>
            <button id="devToolsClose" class="dev-tools-close">×</button>
          </div>
          <div class="dev-tools-content" id="devToolsContent">
            <!-- Dev tools content will be populated here -->
          </div>
        </div>
        
        <!-- Context Menu -->
        <div id="contextMenu" class="context-menu hidden">
          <button class="context-menu-item" id="ctxInspect">Inspect Element</button>
          <button class="context-menu-item" id="ctxCopySelector">Copy Selector</button>
          <button class="context-menu-item" id="ctxCopyStyles">Copy Styles</button>
          <div class="context-menu-divider"></div>
          <button class="context-menu-item" id="ctxEditStyles">Edit Styles</button>
          <button class="context-menu-item" id="ctxScreenshot">Screenshot Element</button>
        </div>
      </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
    }
}
function createNonce() {
    return Math.random().toString(36).slice(2);
}
function buildPortMappings(url) {
    const common = [3000, 3001, 4200, 5173, 5174, 8000, 8080, 8443, 8888, 9000];
    const mappings = new Map();
    for (const p of common) {
        mappings.set(p, p);
    }
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
        if (port && !isNaN(port)) {
            mappings.set(port, port);
        }
    }
    catch {
        // invalid URL, skip
    }
    return Array.from(mappings, ([webviewPort, extensionHostPort]) => ({
        webviewPort,
        extensionHostPort,
    }));
}
function isBlankPageUrl(url) {
    return url.trim().toLowerCase() === "about:blank";
}
function isBlankPageTitle(title) {
    return title.trim().toLowerCase() === "about:blank";
}
function formatDiagnosticLine(message, data) {
    const suffix = data === undefined ? "" : ` ${safeJson(data)}`;
    return `[${new Date().toISOString()}] ${message}${suffix}`;
}
function safeJson(data) {
    try {
        return JSON.stringify(data);
    }
    catch {
        return String(data);
    }
}
function formatError(error) {
    return error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.trim() : String(error);
}
async function safeExecuteCommand(...commandIds) {
    for (const id of commandIds) {
        try {
            await vscode.commands.executeCommand(id);
            return;
        }
        catch {
            // command not available in this IDE, try next
        }
    }
}
//# sourceMappingURL=livePreviewManager.js.map