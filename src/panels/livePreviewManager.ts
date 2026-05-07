import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import { BrowserSession } from "../browser/browserSession";
import { serializeSelectionContext } from "../browser/contextExport";
import { buildElementReference } from "../browser/inspectorModel";
import { PickerController } from "../browser/pickerController";
import { ensureBrowserProfileDirectory } from "../profile/browserProfilePath";
import {
  BrowserNavigationState,
  ElementBox,
  ElementReference,
  ElementInspectorData,
  ElementScreenshot,
  PreviewSecuritySettings,
} from "../browser/types";
import { WorkspaceState } from "../state/workspaceState";
import { SelectionContextStore } from "../state/selectionContextStore";
import { SerializedPreviewPanel } from "../types";
import { writeImageToSystemClipboard } from "../utils/systemClipboard";
import { hostnameLabel, validatePreviewUrl } from "../utils/url";

interface BrowserWorkbenchMessage {
  type: string;
  payload?: Record<string, unknown>;
}

interface WebviewFrameDiagnostic {
  currentUrl?: string;
  dataUrlLength?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  loadedAt?: string;
}

interface PickedElementPayload {
  cancelled?: boolean;
  clientX?: number;
  clientY?: number;
  outerHTML?: string;
  selector?: string;
  tag?: string;
  textSnippet?: string;
}

interface CaptureScreenshotResponse {
  data: string;
}

interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export class LivePreviewManager implements vscode.Disposable {
  private readonly panels = new Map<string, LivePreviewPanelController>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly outputChannel: vscode.OutputChannel;
  private lastActivePanelId: string | undefined;

  /**
   * Tracks the last focused text editor. We cannot use vscode.window.activeTextEditor
   * when handling element picks because the webview panel steals focus at click time,
   * making activeTextEditor === undefined. Instead we snapshot it on every change.
   */
  private lastKnownEditor: vscode.TextEditor | undefined;
  private readonly editorTracker: vscode.Disposable;

  public cdpSession: BrowserSession | undefined;
  private cdpSessionPromise: Promise<BrowserSession> | undefined;
  private cdpSessionRefCount = 0;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceState: WorkspaceState,
    private readonly selectionContextStore: SelectionContextStore,
  ) {
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

  public async open(rawUrl?: string): Promise<void> {
    const fallbackUrl = this.getFallbackPreviewUrl();
    const reusable = this.getReusablePanel();

    if (reusable) {
      reusable.reveal();
      await reusable.navigateFromManager(rawUrl ?? fallbackUrl);
      return;
    }

    await this.createPanel(rawUrl ?? fallbackUrl, false);
  }

  public async openInNewPanel(rawUrl?: string, pinned = false): Promise<void> {
    const fallbackUrl = this.getFallbackPreviewUrl();
    await this.createPanel(rawUrl ?? fallbackUrl, pinned);
  }

  public focusCurrent(): void {
    this.getLastActivePanel()?.reveal();
  }

  public async pinCurrent(): Promise<void> {
    const active = this.getLastActivePanel();
    if (!active) {
      void vscode.window.showInformationMessage("There is no active Browser Workbench panel to pin.");
      return;
    }
    active.togglePinned();
  }

  public async goBack(): Promise<void> {
    this.getLastActivePanel()?.sendCommand("browser.goBack");
  }

  public async goForward(): Promise<void> {
    this.getLastActivePanel()?.sendCommand("browser.goForward");
  }

  public async reload(ignoreCache = false): Promise<void> {
    this.getLastActivePanel()?.sendCommand("browser.reload");
  }

  public async copyUrl(): Promise<void> {
    await this.getLastActivePanel()?.copyUrl();
  }

  public async openExternal(): Promise<void> {
    await this.getLastActivePanel()?.openExternal();
  }

  public async togglePickMode(): Promise<void> {
    this.getLastActivePanel()?.sendCommand("browser.togglePickMode");
  }

  public async copyContextForAi(): Promise<void> {
    const context = this.buildSelectionContextExport();
    if (!context) {
      void vscode.window.showInformationMessage("Pick an element before copying browser context for AI.");
      return;
    }

    await vscode.env.clipboard.writeText(context);
    vscode.window.setStatusBarMessage("$(copy) Browser selection context copied", 2500);
  }

  private elementIdCounter = 0;

  public nextCursorElementId(): string {
    this.elementIdCounter += 1;
    return `cursor-el-${this.elementIdCounter}`;
  }

  public async sendSingleElementToIdeAgent(element: ElementReference): Promise<void> {
    const cursorElementId = this.nextCursorElementId();

    const prompt = formatElementDomForAgent(
      {
        tagName: element.tagName,
        selector: element.selector,
        outerHtml: element.outerHtml,
        attributes: element.attributes,
        box: element.box,
        cursorElementId,
      },
      getAgentDomFormatConfig(),
    );

    await this.handoffPromptToIdeAgent(prompt, "Picked element");
  }

  public async sendScreenshotToIdeAgent(
    dataUrl: string,
    options: {
      clip?: ScreenshotClip | null;
      currentUrl?: string;
      label: string;
    },
  ): Promise<void> {
    const asset = await this.persistDataUrlAsset(dataUrl, "browser-capture");

    if (asset) {
      const placedOnClipboard = await writeImageToSystemClipboard(asset.filePath, asset.mime);
      if (placedOnClipboard) {
        await this.openChatPanelOnly();
        await delay(520);
        await this.tryPasteIntoChatInput();

        // We can't reliably detect whether Cursor's composer actually
        // received the paste (the command reports success even when focus
        // wasn't on the chat input). Always tell the user the screenshot is
        // on the clipboard so they can paste it themselves if needed.
        const pasteShortcut = process.platform === "darwin" ? "⌘V" : "Ctrl+V";
        vscode.window.setStatusBarMessage(
          `$(device-camera) ${options.label} sent to agent — press ${pasteShortcut} if it didn't appear`,
          5000,
        );
        void vscode.window.showInformationMessage(
          `📸 Screenshot copied to clipboard. If it didn't appear in the agent textbox, click the chat input and press ${pasteShortcut}.`,
        );
        this.getLastActivePanel()?.sendCommand("browser.screenshotToast", {
          label: options.label,
          shortcut: pasteShortcut,
        });
        return;
      }
    }

    // Fallback: clipboard image write failed (missing OS tool / unsupported platform).
    // Send a text prompt with the file path so the agent can still see the screenshot.
    const clipSummary = options.clip
      ? `- Capture Box: ${Math.round(options.clip.width)}x${Math.round(options.clip.height)} at (${Math.round(options.clip.x)}, ${Math.round(options.clip.y)})`
      : undefined;

    const prompt = [
      "Browser Workbench screenshot context for the IDE agent.",
      "Use this capture as visual reference for the next UI change request.",
      options.currentUrl ? `- Page URL: ${options.currentUrl}` : undefined,
      `- Capture Type: ${options.label}`,
      asset ? `- Screenshot File: ${asset.filePath}` : undefined,
      clipSummary,
    ]
      .filter(Boolean)
      .join("\n");

    await this.handoffPromptToIdeAgent(prompt, "Browser screenshot");
  }

  public async clearSelections(): Promise<void> {
    this.selectionContextStore.clear();
    this.getLastActivePanel()?.sendCommand("browser.selectionContextChanged");
  }

  /**
   * Insert selected element HTML/info at the last known text editor cursor position.
   *
   * We deliberately use `lastKnownEditor` instead of `vscode.window.activeTextEditor`
   * because clicking inside the browser webview to pick an element causes VS Code to
   * switch the active editor to `undefined` (the webview), so `activeTextEditor` is
   * always null by the time the pick message arrives.
   */
  public async insertAtEditorCursor(content: string): Promise<void> {
    // Prefer the current active editor; fall back to the last known one.
    const editor = vscode.window.activeTextEditor ?? this.lastKnownEditor;
    if (!editor) {
      await vscode.env.clipboard.writeText(content);
      vscode.window.showInformationMessage(
        'Element HTML copied to clipboard (no text editor was open when you picked the element).'
      );
      return;
    }
    const success = await editor.edit(editBuilder => {
      for (const selection of editor.selections) {
        if (!selection.isEmpty) {
          editBuilder.replace(selection, content);
        } else {
          editBuilder.insert(selection.active, content);
        }
      }
    });
    if (success) {
      vscode.window.setStatusBarMessage('$(code) Element HTML inserted at cursor', 2500);
    } else {
      // Editor might be read-only – fall back to clipboard
      await vscode.env.clipboard.writeText(content);
      vscode.window.showInformationMessage('Editor is read-only — element HTML copied to clipboard instead.');
    }
  }

  public hasOpenPanel(): boolean {
    return this.panels.size > 0;
  }

  public getCurrentUrl(): string | undefined {
    return this.getLastActivePanel()?.currentUrl;
  }

  public getSelectionContext(): readonly ElementReference[] {
    return this.selectionContextStore.getSelections();
  }

  public get onDidChangeSelectionContext(): vscode.Event<readonly ElementReference[]> {
    return this.selectionContextStore.onDidChange;
  }

  public appendSelection(reference: ElementReference): void {
    this.selectionContextStore.appendSelection(reference);
  }

  public getSelectionContextExport(): string | undefined {
    return this.buildSelectionContextExport();
  }

  public trace(message: string, data?: unknown): void {
    const configuration = vscode.workspace.getConfiguration("myPreview");
    if (!configuration.get<boolean>("debugLogging", false)) {
      return;
    }

    this.outputChannel.appendLine(formatDiagnosticLine(message, data));
  }

  public async showDiagnostics(): Promise<void> {
    const active = this.getLastActivePanel();
    this.outputChannel.show(true);
    this.outputChannel.appendLine("");
    this.outputChannel.appendLine(`--- My Preview diagnostics ${new Date().toISOString()} ---`);
    this.outputChannel.appendLine(`Active panel URL: ${active?.currentUrl ?? "<none>"}`);
    this.outputChannel.appendLine(`Panel visible: ${active ? String(active.visible) : "<none>"}`);
    this.outputChannel.appendLine(`Panel last frame: ${JSON.stringify(active?.lastFrameDiagnostic ?? null)}`);

    await this.logChatCommandAvailability();

    if (!this.cdpSession) {
      this.outputChannel.appendLine("CDP session: <not created>");
      return;
    }

    try {
      const state = await this.cdpSession.getNavigationState();
      this.outputChannel.appendLine(`CDP URL: ${state.currentUrl}`);
      this.outputChannel.appendLine(`CDP title: ${state.title}`);
    } catch (error) {
      this.outputChannel.appendLine(`CDP navigation state error: ${formatError(error)}`);
    }

    try {
      const page = await this.cdpSession.evaluateJson<Record<string, unknown>>(`(() => ({
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyTextLength: document.body ? document.body.innerText.length : 0,
        background: getComputedStyle(document.body || document.documentElement).backgroundColor,
        visibility: document.visibilityState
      }))()`);
      this.outputChannel.appendLine(`DOM snapshot: ${JSON.stringify(page ?? null)}`);
    } catch (error) {
      this.outputChannel.appendLine(`DOM snapshot error: ${formatError(error)}`);
    }

    try {
      const shot = await this.cdpSession.captureScreenshot();
      this.outputChannel.appendLine(`Screenshot: ${shot.width}x${shot.height}, dataUrlLength=${shot.dataUrl.length}, prefix=${shot.dataUrl.slice(0, 23)}`);
    } catch (error) {
      this.outputChannel.appendLine(`Screenshot error: ${formatError(error)}`);
    }
  }

  private async logChatCommandAvailability(): Promise<void> {
    try {
      const all = await vscode.commands.getCommands(true);
      const present = (list: readonly string[]) => list.filter((c) => all.includes(c));
      const missing = (list: readonly string[]) => list.filter((c) => !all.includes(c));

      this.outputChannel.appendLine("");
      this.outputChannel.appendLine("Chat command discovery:");
      this.outputChannel.appendLine(`  open: present = ${JSON.stringify(present(IDE_AGENT_OPEN_COMMANDS))}`);
      this.outputChannel.appendLine(`  open: missing = ${JSON.stringify(missing(IDE_AGENT_OPEN_COMMANDS))}`);
      this.outputChannel.appendLine(`  focus: present = ${JSON.stringify(present(IDE_AGENT_FOCUS_COMMANDS))}`);
      this.outputChannel.appendLine(`  focus: missing = ${JSON.stringify(missing(IDE_AGENT_FOCUS_COMMANDS))}`);
      this.outputChannel.appendLine(`  paste: present = ${JSON.stringify(present(IDE_AGENT_PASTE_COMMANDS))}`);
      this.outputChannel.appendLine(`  paste: missing = ${JSON.stringify(missing(IDE_AGENT_PASTE_COMMANDS))}`);

      const dynFocus = discoverComposerChatFocusCandidates(all);
      const dynPaste = discoverComposerChatPasteCandidates(all);
      this.outputChannel.appendLine(`  dynamic focus candidates (top 15): ${JSON.stringify(dynFocus.slice(0, 15))}`);
      this.outputChannel.appendLine(`  dynamic paste candidates (top 15): ${JSON.stringify(dynPaste.slice(0, 15))}`);

      const chatRelated = all.filter((c) =>
        /chat|composer|aichat|conversation/i.test(c)
      );
      this.outputChannel.appendLine(`  total chat-ish commands found: ${chatRelated.length}`);
      for (const c of chatRelated.slice(0, 80)) {
        this.outputChannel.appendLine(`    - ${c}`);
      }
      if (chatRelated.length > 80) {
        this.outputChannel.appendLine(`    ... and ${chatRelated.length - 80} more`);
      }
    } catch (error) {
      this.outputChannel.appendLine(`Chat command discovery failed: ${formatError(error)}`);
    }
  }

  /* ── Bridge/MCP API (uses CDP session lazily) ── */

  public async bridgeNavigate(url: string): Promise<void> {
    const panel = this.getLastActivePanel();
    if (panel) {
      await panel.navigateFromManager(url);
      return;
    }
    const session = await this.ensureCdpSession();
    await session.navigate(url);
  }

  public async bridgeScreenshot(): Promise<{ mime: string; base64: string }> {
    const session = await this.ensureCdpSession();
    const shot = await session.captureScreenshot();
    const match = shot.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error("Screenshot capture returned an unexpected format.");
    }
    return { mime: match[1], base64: match[2] };
  }

  public async bridgeGetDom(): Promise<string> {
    const session = await this.ensureCdpSession();
    return session.getDocumentHtml();
  }

  public async bridgeClick(x: number, y: number): Promise<void> {
    const session = await this.ensureCdpSession();
    await session.clickPoint(x, y);
  }

  public async bridgeGetCurrentUrl(): Promise<string | undefined> {
    return this.getLastActivePanel()?.currentUrl;
  }

  public dispose(): void {
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

  private getReusablePanel(): LivePreviewPanelController | undefined {
    const active = this.getLastActivePanel();
    if (active && !active.pinned) {
      return active;
    }
    return [...this.panels.values()].find((panel) => !panel.pinned);
  }

  private getLastActivePanel(): LivePreviewPanelController | undefined {
    return this.lastActivePanelId ? this.panels.get(this.lastActivePanelId) : undefined;
  }

  private getFallbackPreviewUrl(): string {
    const lastUrl = this.workspaceState.getLastPreviewUrl();
    return lastUrl && !isBlankPageUrl(lastUrl) ? lastUrl : "http://localhost:3000";
  }

  private async ensureCdpSession(): Promise<BrowserSession> {
    if (this.cdpSession) {
      return this.cdpSession;
    }

    if (this.cdpSessionPromise) {
      return this.cdpSessionPromise;
    }

    const configuration = vscode.workspace.getConfiguration("myPreview");

    const usePersistentProfile = configuration.get<boolean>("persistUserDataDir", false);
    let userDataDir: string | undefined;
    let persistUserDataDir = false;

    if (usePersistentProfile) {
      userDataDir = await ensureBrowserProfileDirectory(this.context);
      persistUserDataDir = true;
    }

    const rawScale = configuration.get<number>("deviceScaleFactor", 2);
    const deviceScaleFactor = Math.min(3, Math.max(1, isFinite(rawScale) ? rawScale : 2));

    const browserConfig = {
      executablePath: configuration.get<string>("browserExecutablePath", "").trim() || undefined,
      viewport: {
        width: configuration.get<number>("viewportWidth", 1440),
        height: configuration.get<number>("viewportHeight", 900),
        deviceScaleFactor,
      },
      screenshotFormat: configuration.get<"jpeg" | "png">("screenshotFormat", "jpeg"),
      jpegQuality: configuration.get<number>("jpegQuality", 92),
      userDataDir,
      persistUserDataDir,
    };

    this.cdpSessionPromise = BrowserSession.create(browserConfig)
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

  private async createPanel(initialUrl: string, pinned: boolean): Promise<void> {
    const panelId = `preview-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const portMappings = buildPortMappings(initialUrl);
    const panel = vscode.window.createWebviewPanel(
      "myPreview.browserWorkbench",
      "Browser Workbench",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        enableForms: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
        portMapping: portMappings,
      },
    );

    const controller = new LivePreviewPanelController(
      panelId,
      panel,
      this.context,
      this.workspaceState,
      initialUrl,
      pinned,
      this,
      () => {
        this.lastActivePanelId = panelId;
        this.syncStatusBar();
      },
      async (snapshot) => {
        this.lastActivePanelId = panelId;
        await this.workspaceState.setLastPreviewUrl(snapshot.url);
        await this.workspaceState.upsertPanelSnapshot(snapshot);
        this.syncStatusBar();
      },
      async (disposedPanelId) => {
        this.panels.delete(disposedPanelId);
        this.syncStatusBar();
      },
      this.ensureCdpSession.bind(this),
      this.trace.bind(this)
    );

    this.panels.set(panelId, controller);
    this.lastActivePanelId = panelId;
    this.syncStatusBar();
  }

  private syncStatusBar(): void {
    const active = this.getLastActivePanel();
    const activeUrl = active?.currentUrl;
    this.statusBar.text = activeUrl
      ? `Browser: ${hostnameLabel(activeUrl)}`
      : "Browser: idle";
  }

  private buildSelectionContextExport(): string | undefined {
    const selections = [...this.selectionContextStore.getSelections()];
    if (selections.length === 0) {
      return undefined;
    }

    return serializeSelectionContext(selections);
  }

  private async persistDataUrlAsset(dataUrl: string, prefix: string): Promise<PersistedAsset | undefined> {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return undefined;
    }

    const [, mime, base64] = match;
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "bin";
    const directory = path.join(this.context.globalStorageUri.fsPath, "agent-artifacts");
    const filePath = path.join(
      directory,
      `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${extension}`,
    );

    await mkdir(directory, { recursive: true });
    await writeFile(filePath, Buffer.from(base64, "base64"));
    return { filePath, mime };
  }

  public async handoffPromptToIdeAgent(prompt: string, label: string): Promise<void> {
    // Use the EXACT same path that already works for screenshots: write to the
    // system clipboard, surface the composer (which leaves its Monaco input
    // focused), then run the editor paste command.
    await vscode.env.clipboard.writeText(prompt);
    this.trace("ideAgent.handoff.start", { label, promptLength: prompt.length });

    await this.openChatPanelOnly();
    await delay(520);

    const pasted = await this.tryPasteIntoChatInput();
    if (pasted) {
      this.trace("ideAgent.handoff.pasted", { label });
      vscode.window.setStatusBarMessage(`$(comment-discussion) ${label} pasted into agent`, 3000);
      return;
    }

    // Final fallback: simulate keystrokes via the `type` command. This works
    // when `editor.action.clipboardPasteAction` doesn't (e.g. composer input
    // was focused but Cursor swallowed the paste).
    const typed = await this.tryTypeIntoChatInput(prompt);
    if (typed) {
      this.trace("ideAgent.handoff.typed", { label });
      vscode.window.setStatusBarMessage(`$(comment-discussion) ${label} typed into agent`, 3000);
      return;
    }

    this.trace("ideAgent.handoff.failed", { label });
    void vscode.window.showInformationMessage(
      `${label} copied. Press Cmd/Ctrl+V in the chat input to paste it.`,
    );
  }

  /**
   * Opens / surfaces the **persistent** chat panel (the sidebar / dock view),
   * NOT the floating "Quick Composer" overlay. The first call opens it; every
   * subsequent call only focuses it, so we never accidentally toggle / close
   * an already-open chat or replace its existing prompt content.
   *
   * Avoids `composer.startComposerPrompt*` because those open the floating
   * Quick Composer (it dismisses when focus shifts, which the user perceives
   * as a "toast" of their pasted DOM).
   */
  private chatPanelEverOpened = false;

  private async openChatPanelOnly(): Promise<void> {
    const allCommands = await vscode.commands.getCommands(true);

    // Persistent panel openers: open the sidebar / dock chat view that stays open.
    const persistentOpenCandidates = [
      "workbench.action.chat.open",
      "aichat.newchataction",
    ];

    // Persistent focus candidates: just bring the existing chat into focus.
    const persistentFocusCandidates = [
      "workbench.panel.chat.view.copilot.focus",
      "workbench.action.chat.open",
      "aichat.newchataction",
    ];

    const sequence = this.chatPanelEverOpened ? persistentFocusCandidates : persistentOpenCandidates;

    for (const command of sequence) {
      if (!allCommands.includes(command)) continue;
      try {
        await vscode.commands.executeCommand(command);
        this.trace("ideAgent.openPanel.ok", { command, mode: this.chatPanelEverOpened ? "focus" : "open" });
        this.chatPanelEverOpened = true;
        return;
      } catch (error) {
        this.trace("ideAgent.openPanel.error", { command, error: formatError(error) });
      }
    }

    // If neither persistent surface was available, the floating Quick Composer
    // is the last resort — at least the user's DOM goes somewhere visible.
    for (const command of ["composer.startComposerPrompt", "composer.startComposerPrompt2"]) {
      if (!allCommands.includes(command)) continue;
      try {
        await vscode.commands.executeCommand(command);
        this.trace("ideAgent.openPanel.fallback", { command });
        this.chatPanelEverOpened = true;
        return;
      } catch (error) {
        this.trace("ideAgent.openPanel.fallback.error", { command, error: formatError(error) });
      }
    }
  }

  /**
   * Pastes the current clipboard into whatever input is focused. Cursor does
   * not expose a chat-aware paste command in any build I've seen, so we rely
   * on `editor.action.clipboardPasteAction` after `openChatPanelOnly()` has
   * surfaced the composer (which leaves its Monaco-based input focused).
   */
  private async tryPasteIntoChatInput(): Promise<boolean> {
    const allCommands = await vscode.commands.getCommands(true);

    for (const command of IDE_AGENT_PASTE_COMMANDS) {
      if (!allCommands.includes(command)) continue;
      try {
        await vscode.commands.executeCommand(command);
        return true;
      } catch (error) {
        this.trace("ideAgent.paste.error", { command, error: formatError(error) });
      }
    }

    return false;
  }

  /**
   * Last-resort fallback: simulate typing via VS Code's built-in `type`
   * command. This routes characters into whatever Monaco editor currently
   * has focus, including Cursor's composer input. We chunk the text to avoid
   * starving the event loop on long DOM strings.
   */
  private async tryTypeIntoChatInput(text: string): Promise<boolean> {
    if (!text) return false;
    const allCommands = await vscode.commands.getCommands(true);
    if (!allCommands.includes("type")) return false;

    try {
      const chunkSize = 200;
      for (let i = 0; i < text.length; i += chunkSize) {
        await vscode.commands.executeCommand("type", { text: text.slice(i, i + chunkSize) });
      }
      return true;
    } catch (error) {
      this.trace("ideAgent.type.error", { error: formatError(error) });
      return false;
    }
  }
}

interface PersistedAsset {
  filePath: string;
  mime: string;
}

class LivePreviewPanelController implements vscode.Disposable {
  private disposed = false;
  public currentUrl = "";
  public pinned: boolean;

  public constructor(
    public readonly id: string,
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceState: WorkspaceState,
    initialUrl: string,
    pinned: boolean,
    private readonly manager: LivePreviewManager,
    private readonly onFocused: () => void,
    private readonly onSnapshot: (snapshot: SerializedPreviewPanel) => Promise<void>,
    private readonly onDisposed: (id: string) => Promise<void>,
    private readonly getContextSession: () => Promise<BrowserSession>,
    private readonly trace: (message: string, data?: unknown) => void
  ) {
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

    this.panel.webview.onDidReceiveMessage((message: BrowserWorkbenchMessage) => {
      void this.handleMessage(message);
    });

    void this.pollLoop();
  }

  private polling = false;
  private pickMode = false;
  private pickerInjected = false;
  private pickerUnsubscribe: (() => void) | undefined;
  private awaitingNavigationCommit = false;
  public lastFrameDiagnostic: WebviewFrameDiagnostic | undefined;

  public get visible(): boolean {
    return this.panel.visible;
  }

  private async pollLoop() {
    if (this.polling) return;
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
      } catch (e) {
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
        } catch (e) {
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

  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, false);
  }

  public dispose(): void {
    this.panel.dispose();
  }

  public navigateViaMessage(url: string): void {
    this.postToWebview("browser.navigate", { url });
  }

  public async navigateFromManager(url: string): Promise<void> {
    await this.handleMessage({ type: "browser.navigate", payload: { url } });
  }

  public sendCommand(type: string, payload?: unknown): void {
    this.postToWebview(type, payload);
  }

  private postToWebview(type: string, payload?: unknown): void {
    if (this.disposed) {
      return;
    }

    try {
      void this.panel.webview.postMessage({ type, payload }).then(undefined, (error) => {
        this.trace("webview.postMessage.error", { type, error: formatError(error) });
      });
    } catch (error) {
      this.trace("webview.postMessage.error", { type, error: formatError(error) });
    }
  }

  public togglePinned(): void {
    this.pinned = !this.pinned;
    this.updateTitle();
    void this.snapshot();
  }

  public async copyUrl(): Promise<void> {
    if (!this.currentUrl) return;
    await vscode.env.clipboard.writeText(this.currentUrl);
  }

  public async openExternal(): Promise<void> {
    if (!this.currentUrl) return;
    await vscode.env.openExternal(vscode.Uri.parse(this.currentUrl));
  }

  private async handleMessage(message: BrowserWorkbenchMessage): Promise<void> {
    const payload = message.payload || {};

    switch (message.type) {
      case "browser.ready":
        break;

      case "browser.navigate":
        if (payload && payload.url) {
          try {
            const { url, warnings } = validatePreviewUrl(String(payload.url), this.getSecuritySettings());
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
          } catch (e) {
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
        } catch (e) { }
        break;

      case "browser.hardReload":
        try {
          const session = await this.getContextSession();
          await session.reload(true);
        } catch (e) { }
        break;

      case "browser.goBack":
        try {
          const session = await this.getContextSession();
          await session.goBack();
        } catch (e) { }
        break;

      case "browser.goForward":
        try {
          const session = await this.getContextSession();
          await session.goForward();
        } catch (e) { }
        break;

      case "browser.didNavigate": {
        const url = typeof payload.url === "string" ? payload.url : "";
        if (url && !isBlankPageUrl(url)) {
          this.currentUrl = url;
          this.awaitingNavigationCommit = !isBlankPageUrl(url);
          this.updateTitle();
          void this.snapshot();
        } else if (url) {
          this.trace("webview.didNavigate.ignoredBlank", { url });
        }
        break;
      }

      case "browser.titleChanged": {
        const title = typeof payload.title === "string" ? payload.title : "";
        if (title && !isBlankPageTitle(title)) {
          this.updateTitle(title);
        } else if (title) {
          this.trace("webview.titleChanged.ignoredBlank", { title });
        }
        break;
      }

      case "browser.frameLoaded": {
        this.lastFrameDiagnostic = payload as WebviewFrameDiagnostic;
        this.trace("webview.frameLoaded", this.lastFrameDiagnostic);
        break;
      }

      case "browser.copyUrl":
        await this.copyUrl();
        break;

      case "browser.togglePickMode": {
        const nowActive = Boolean(payload?.active);
        this.pickMode = nowActive;
        // In the CDP streaming architecture, we don't inject the DOM picker script.
        // We rely entirely on `DOM.getNodeForLocation` handling in mousemove/click.
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
          } catch (e) { }
        }
        break;

      case "browser.keyup":
        if (payload?.key) {
          try {
            const session = await this.getContextSession();
            await session.sendKey("keyUp", String(payload.key));
          } catch (e) { }
        }
        break;

      case "browser.mousemove":
        if (this.pickMode && payload) {
          try {
            const session = await this.getContextSession();
            const { backendNodeId } = await session.send("DOM.getNodeForLocation", { x: Number(payload.x), y: Number(payload.y), includeUserAgentShadowDOM: true }) as any;
            if (backendNodeId) {
              const model = await session.send("DOM.getBoxModel", { backendNodeId }) as any;
              const node = await session.send("DOM.describeNode", { backendNodeId }) as any;
              this.postToWebview("browser.inspectHover", { box: model.model.border, node: node.node });
            }
          } catch (e) { }
        } else if (payload) {
          try {
            const session = await this.getContextSession();
            await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(payload.x), y: Number(payload.y), button: "none" });
          } catch (e) { }
        }
        break;

      case "browser.click":
        if (payload) {
          try {
            const x = Number(payload.x);
            const y = Number(payload.y);

            if (this.pickMode) {
              await this.handleElementPicked({ clientX: x, clientY: y });
              // Stay in pick mode so user can click multiple elements
              break;
            }

            const session = await this.getContextSession();
            await session.clickPoint(x, y);
          } catch (e) { }
        }
        break;

      case "browser.elementPicked": {
        const picked = payload as PickedElementPayload;
        if (picked.cancelled) {
          this.pickerUnsubscribe?.();
          this.pickerUnsubscribe = undefined;
          this.pickMode = false;
          this.pickerInjected = false;
          this.postToWebview("browser.togglePickMode", { active: false });
          this.postToWebview("browser.inspectHover", null);
        } else {
          await this.handleElementPicked(picked);
          // Stay in pick mode for multi-pick
        }
        break;
      }

      case "browser.wheel":
        if (payload) {
          try {
            const session = await this.getContextSession();
            await session.scrollBy(Number(payload.deltaX), Number(payload.deltaY));
          } catch (e) { }
        }
        break;

      case "browser.clearCache":
        try {
          const session = await this.getContextSession();
          await session.clearCache();
        } catch (e) { }
        break;

      case "browser.clearCookies":
        try {
          const session = await this.getContextSession();
          await session.clearCookies();
        } catch (e) { }
        break;

      case "browser.setZoom":
        try {
          const session = await this.getContextSession();
          await session.setZoom(Number(payload?.scale ?? 1));
        } catch (e) { }
        break;

      case "browser.resize":
        try {
          if (payload && payload.width && payload.height) {
            const session = await this.getContextSession();
            await session.updateViewport(Number(payload.width), Number(payload.height));
          }
        } catch (e) { }
        break;

      case "webview.ready":
        break;

      case "cursor.bridge":
        break;

      case "browser.selectionsChanged":
        if (Array.isArray((payload as { selections?: unknown[] }).selections)
          && (payload as { selections?: unknown[] }).selections?.length === 0) {
          await this.manager.clearSelections();
        }
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
        } catch (e) { }
        break;

      case "browser.contextmenu":
        break;

      case "browser.newTab":
        try {
          const lastUrl = this.workspaceState.getLastPreviewUrl();
          const newUrl = lastUrl && !isBlankPageUrl(lastUrl) ? lastUrl : "http://localhost:3000";
          this.postToWebview("browser.navigate", { url: newUrl });
        } catch (e) { }
        break;

      case "browser.closeTab":
        try {
          this.panel.dispose();
        } catch (e) { }
        break;

      case "browser.toggleSidebar":
        try {
          await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
        } catch (e) { }
        break;

      case "browser.selectAll":
        try {
          const session = await this.getContextSession();
          await session.send("Runtime.evaluate", {
            expression: "document.execCommand('selectAll')"
          });
        } catch (e) { }
        break;

      case "browser.toggleBookmark":
        break;

      case "browser.takeScreenshot":
        try {
          const session = await this.getContextSession();
          const shot = await session.captureScreenshot();
          if (shot?.dataUrl) {
            this.postToWebview("browser.areaScreenshot", { dataUrl: shot.dataUrl, clip: null });
            await this.manager.sendScreenshotToIdeAgent(shot.dataUrl, {
              currentUrl: this.currentUrl,
              label: "Full Page Screenshot",
            });
          }
        } catch (e) {
          console.error('[LivePreview] Take screenshot failed:', e);
        }
        break;

      case "browser.clearBrowsingHistory":
        try {
          const session = await this.getContextSession();
          await session.clearBrowsingHistory(this.currentUrl);
        } catch (e) { }
        break;

      case "browser.captureArea":
        try {
          // Capture specific area by element selector or bounding box
          const session = await this.getContextSession();
          let clip: ScreenshotClip | undefined;

          if (payload?.selector) {
            // Get bounding box of specified element
            const expr = `(() => {
              const el = document.querySelector(${JSON.stringify(String(payload.selector))});
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            })()`;
            const res = await session.send<{ result?: { value?: { x: number; y: number; width: number; height: number } | null } }>("Runtime.evaluate", { expression: expr, returnByValue: true });
            const box = res?.result?.value;
            if (box && box.width > 0 && box.height > 0) {
              clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
            }
          } else if (payload?.x !== undefined && payload?.width !== undefined) {
            // Direct bounding box provided
            clip = { x: Number(payload.x), y: Number(payload.y), width: Number(payload.width), height: Number(payload.height), scale: 1 };
          }

          const format = "png"; // PNG for area crops preserves quality
          const params: Record<string, unknown> = { format, captureBeyondViewport: false };
          if (clip) { params.clip = clip; }

          const resp = await session.send<{ data: string }>("Page.captureScreenshot", params);
          if (resp?.data) {
            const dataUrl = `data:image/png;base64,${resp.data}`;
            this.postToWebview("browser.areaScreenshot", { dataUrl, clip });
            await this.manager.sendScreenshotToIdeAgent(dataUrl, {
              clip: clip ?? null,
              currentUrl: this.currentUrl,
              label: payload?.selector ? "Element Screenshot" : "Area Screenshot",
            });
          }
        } catch (e) {
          console.error('[LivePreview] Area capture failed:', e);
        }
        break;

      default:
        break;
    }
  }

  private async handleElementPicked(payload: PickedElementPayload): Promise<void> {
    const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : "element";
    const html = typeof payload.outerHTML === "string" ? payload.outerHTML : "";

    const selection = await this.resolvePickedSelection(payload);
    if (selection) {
      this.manager.appendSelection(selection);
      this.postToWebview("browser.selectionContextChanged", {
        selections: this.manager.getSelectionContext(),
      });
      this.postToWebview("browser.elementSelected", selection);
      // The handoff itself sets a more accurate status bar message
      // (e.g. "pasted into agent" / "typed into agent" / fall-back info).
      const prompt = await this.buildPickedElementAgentPrompt(selection, payload);
      await this.manager.handoffPromptToIdeAgent(prompt, "Picked element");
      return;
    }

    // Fallback A: webview supplied outerHTML (only in non-streaming mode).
    if (html) {
      const fallbackPrompt = formatElementDomForAgent(
        {
          tagName: tag,
          outerHtml: html,
          cursorElementId: this.manager.nextCursorElementId(),
        },
        getAgentDomFormatConfig(),
      );
      await this.manager.handoffPromptToIdeAgent(fallbackPrompt, "Picked element");
      return;
    }

    // Fallback B: lightweight CDP probe — even when the full picker chain
    // fails (e.g. CSS.getComputedStyleForNode throws), this almost always
    // succeeds because it only needs Runtime.evaluate.
    const probed = await this.probeElementHtmlAt(payload);
    if (probed) {
      const fallbackPrompt = formatElementDomForAgent(
        {
          tagName: probed.tagName,
          selector: probed.selector,
          outerHtml: probed.outerHtml,
          cursorElementId: this.manager.nextCursorElementId(),
        },
        getAgentDomFormatConfig(),
      );
      await this.manager.handoffPromptToIdeAgent(fallbackPrompt, "Picked element");
      return;
    }

    vscode.window.setStatusBarMessage(
      `$(warning) Pick failed for <${tag}> — see "My Preview" output`,
      3500,
    );
  }

  private async buildPickedElementAgentPrompt(
    selection: ElementReference,
    payload: PickedElementPayload,
  ): Promise<string> {
    const cfg = getAgentDomFormatConfig();
    const cursorElementId = this.manager.nextCursorElementId();

    const promoted =
      cfg.promoteSvgPicksToRoot &&
      typeof payload.clientX === "number" &&
      typeof payload.clientY === "number"
        ? await this.tryPromoteSvgInnerPickToOwningSvg(payload.clientX, payload.clientY, selection.tagName)
        : undefined;

    if (promoted) {
      return formatElementDomForAgent(
        {
          tagName: promoted.tagName,
          selector: promoted.selector,
          outerHtml: promoted.outerHtml,
          box: promoted.box,
          cursorElementId,
        },
        cfg,
      );
    }

    return formatElementDomForAgent(
      {
        tagName: selection.tagName,
        selector: selection.selector,
        outerHtml: selection.outerHtml,
        attributes: selection.attributes,
        box: selection.box,
        cursorElementId,
      },
      cfg,
    );
  }

  private async tryPromoteSvgInnerPickToOwningSvg(
    clientX: number,
    clientY: number,
    pickedTagName: string,
  ): Promise<{ tagName: string; selector: string; outerHtml: string; box: ElementBox } | undefined> {
    const tag = pickedTagName.toLowerCase();
    if (tag === "svg" || !SVG_INNER_TAGS_FOR_PROMOTION.has(tag)) {
      return undefined;
    }
    try {
      const session = await this.getContextSession();
      const max = this.getMaxOuterHtmlLength();
      const expr = `(() => {
        const el = document.elementFromPoint(${Math.round(clientX)}, ${Math.round(clientY)});
        if (!el || typeof el.closest !== "function") return null;
        const svg = el.closest("svg");
        if (!svg || el === svg) return null;
        function buildSelector(node) {
          const parts = [];
          let cur = node;
          while (cur && cur.nodeType === 1) {
            let part = cur.localName || (cur.tagName || "").toLowerCase();
            if (!part) break;
            if (cur.id) {
              part += "#" + CSS.escape(cur.id);
              parts.unshift(part);
              break;
            }
            const cls = Array.from(cur.classList || []).slice(0, 2);
            if (cls.length) part += cls.map((c) => "." + CSS.escape(c)).join("");
            parts.unshift(part);
            cur = cur.parentElement;
          }
          return parts.join(" > ");
        }
        const r = svg.getBoundingClientRect();
        return {
          tagName: "svg",
          selector: buildSelector(svg),
          outerHtml: (svg.outerHTML || "").slice(0, ${max}),
          box: {
            x: r.left,
            y: r.top,
            width: r.width,
            height: r.height,
            top: r.top,
            left: r.left,
            right: r.right,
            bottom: r.bottom,
          },
        };
      })()`;
      type Promoted = { tagName: string; selector: string; outerHtml: string; box: ElementBox };
      const resp = await session.send<{ result?: { value?: Promoted | null } }>("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      });
      const value = resp?.result?.value;
      if (!value || !value.outerHtml || value.tagName !== "svg") {
        return undefined;
      }
      this.trace("picker.svgPromote.ok", { fromTag: tag, selector: value.selector });
      return value;
    } catch (error) {
      this.trace("picker.svgPromote.error", { error: formatError(error) });
      return undefined;
    }
  }

  private async probeElementHtmlAt(payload: PickedElementPayload): Promise<{
    tagName: string;
    selector: string;
    outerHtml: string;
    text: string;
  } | undefined> {
    if (typeof payload.clientX !== "number" || typeof payload.clientY !== "number") {
      return undefined;
    }
    try {
      const session = await this.getContextSession();
      const max = this.getMaxOuterHtmlLength();
      const expr = `(() => {
        const el = document.elementFromPoint(${Math.round(payload.clientX)}, ${Math.round(payload.clientY)});
        if (!el) return null;
        function buildSelector(node) {
          const parts = [];
          let cur = node;
          while (cur && cur.nodeType === 1) {
            let part = cur.localName || (cur.tagName || '').toLowerCase();
            if (!part) break;
            if (cur.id) { part += '#' + CSS.escape(cur.id); parts.unshift(part); break; }
            const cls = Array.from(cur.classList || []).slice(0, 2);
            if (cls.length) part += cls.map(c => '.' + CSS.escape(c)).join('');
            parts.unshift(part);
            cur = cur.parentElement;
          }
          return parts.join(' > ');
        }
        return {
          tagName: (el.tagName || '').toLowerCase(),
          selector: buildSelector(el),
          outerHtml: (el.outerHTML || '').slice(0, ${max * 2}),
          text: (el.innerText || el.textContent || '').trim().slice(0, 400),
        };
      })()`;
      const resp = await session.send<{ result?: { value?: { tagName: string; selector: string; outerHtml: string; text: string } | null } }>(
        "Runtime.evaluate",
        { expression: expr, returnByValue: true },
      );
      const value = resp?.result?.value;
      this.trace("picker.probe.result", { hasValue: Boolean(value) });
      if (!value || !value.outerHtml) return undefined;
      return value;
    } catch (error) {
      this.trace("picker.probe.error", { error: formatError(error) });
      return undefined;
    }
  }

  private async resolvePickedSelection(payload: PickedElementPayload): Promise<ElementReference | undefined> {
    if (typeof payload.clientX !== "number" || typeof payload.clientY !== "number" || !this.currentUrl) {
      return undefined;
    }

    try {
      const session = await this.getContextSession();
      const picker = new PickerController(session, this.getMaxOuterHtmlLength(), this.trace);
      const inspector = await picker.inspectPoint(Math.round(payload.clientX), Math.round(payload.clientY), this.currentUrl);

      if (!inspector) {
        this.trace("picker.resolve.inspectorMissing", { x: payload.clientX, y: payload.clientY });
        return undefined;
      }

      const screenshot = await this.captureElementScreenshot(session, inspector);
      const reference = buildElementReference(inspector);
      if (screenshot) {
        reference.screenshot = screenshot;
      }

      return reference;
    } catch (error) {
      this.trace("picker.resolve.error", { payload, error: formatError(error) });
      return undefined;
    }
  }

  private async captureElementScreenshot(
    session: BrowserSession,
    inspector: ElementInspectorData,
  ): Promise<ElementScreenshot | undefined> {
    if (inspector.box.width < 2 || inspector.box.height < 2) {
      return undefined;
    }

    const configuration = vscode.workspace.getConfiguration("myPreview");
    const viewportWidth = configuration.get<number>("viewportWidth", 1440);
    const viewportHeight = configuration.get<number>("viewportHeight", 900);
    const padding = 8;

    const x = clamp(Math.floor(inspector.box.x - padding), 0, Math.max(0, viewportWidth - 1));
    const y = clamp(Math.floor(inspector.box.y - padding), 0, Math.max(0, viewportHeight - 1));
    const width = clamp(
      Math.ceil(inspector.box.width + padding * 2),
      1,
      Math.max(1, viewportWidth - x),
    );
    const height = clamp(
      Math.ceil(inspector.box.height + padding * 2),
      1,
      Math.max(1, viewportHeight - y),
    );

    try {
      await session.send("Page.bringToFront").catch(() => undefined);
      const response = await session.send<CaptureScreenshotResponse>("Page.captureScreenshot", {
        captureBeyondViewport: false,
        clip: { x, y, width, height, scale: 1 },
        format: "png",
      });

      if (!response?.data) {
        return undefined;
      }

      return {
        dataUrl: `data:image/png;base64,${response.data}`,
        width,
        height,
      };
    } catch (error) {
      this.trace("picker.captureElementScreenshot.error", {
        selector: inspector.selector,
        error: formatError(error),
      });
      return undefined;
    }
  }

  private getMaxOuterHtmlLength(): number {
    return vscode.workspace.getConfiguration("myPreview").get<number>("maxOuterHtmlLength", 1200);
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
  private async injectPickerScript(): Promise<void> {
    if (this.pickerInjected) return;
    try {
      const session = await this.getContextSession();

      // 1. Register a named binding so the page can call back into the extension.
      //    Chrome DevTools Protocol: Runtime.addBinding exposes a global
      //    window.__vscodePicker(jsonString) function inside the page.
      await session.send("Runtime.addBinding", { name: "__vscodePicker" });

      // 2. Listen for the binding call event (fires when the page calls the function).
      //    We register only once; the binding auto-disposes when the page navigates.
      this.pickerUnsubscribe?.(); // clean up any previous listener
      this.pickerUnsubscribe = session.onCdpEvent("Runtime.bindingCalled", (params: unknown) => {
        const event = params as { name?: string; payload?: string };
        if (event.name !== "__vscodePicker") return;
        try {
          const data = JSON.parse(event.payload ?? "{}") as PickedElementPayload;
          void this.handleMessage({ type: "browser.elementPicked", payload: data as Record<string, unknown> });
        } catch { /* malformed payload */ }
      });

      // 3. Inject the picker UI script using the bundled pick-dom-element package.
      const { PICKER_SCRIPT } = require("../browser/pickerScript");
      await session.send("Runtime.evaluate", { expression: PICKER_SCRIPT });
      await session.send("Runtime.evaluate", { expression: "window.StartVsCodePicker()" });
      
      this.pickerInjected = true;
      this.postToWebview("browser.pickMode", { active: true });
    } catch (e) {
      console.error("[LivePreview] Failed to inject picker:", e);
    }
  }

  /**
   * Removes the picker overlay from the live browser page and resets cursor.
   */
  private async removePickerScript(): Promise<void> {
    if (!this.pickerInjected) return;
    this.pickerInjected = false;
    try {
      const session = await this.getContextSession();
      await session.send("Runtime.evaluate", { 
        expression: "if (typeof window.StopVsCodePicker === 'function') window.StopVsCodePicker();" 
      });
    } catch { /* page may have navigated */ }
  }

  private async snapshot(): Promise<void> {
    if (!this.currentUrl) return;
    await this.workspaceState.setLastPreviewUrl(this.currentUrl);
    await this.onSnapshot({
      id: this.id,
      url: this.currentUrl,
      pinned: this.pinned,
    });
  }

  private updateTitle(pageTitle?: string): void {
    const host = this.currentUrl ? hostnameLabel(this.currentUrl) : "browser";
    const label = pageTitle || host;
    this.panel.title = this.pinned ? `${label} (Pinned)` : label;
  }

  private applyNavigationState(state: BrowserNavigationState): boolean {
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
    } else {
      this.updateTitle();
    }

    return true;
  }

  private getSecuritySettings(): PreviewSecuritySettings {
    const configuration = vscode.workspace.getConfiguration("myPreview");

    return {
      allowLocalhost: configuration.get<boolean>("allowLocalhost", true),
      allowPrivateHosts: configuration.get<boolean>("allowPrivateHosts", false),
      allowedHosts: configuration
        .get<string[]>("allowedHosts", [])
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    };
  }

  private renderHtml(webview: vscode.Webview, initialUrl: string): string {
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
          <button id="cssInspectorButton" title="Inspect Selected Element (CSS)" class="icon-btn" aria-label="CSS Inspector">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 2h6v6H2z" stroke="currentColor" stroke-width="1.2" fill="none"/>
              <path d="M9 9h5v5H9z" stroke="currentColor" stroke-width="1.2" fill="none"/>
              <path d="M5 5l8 8" stroke="currentColor" stroke-width="1" stroke-dasharray="1.5 1.5"/>
            </svg>
          </button>
          <button id="componentsButton" title="Toggle Components Tree" class="icon-btn" aria-label="Components Tree">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1.5" y="1.5" width="6" height="13" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/>
              <path d="M9.5 4h5M9.5 8h5M9.5 12h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </button>
          <div class="separator"></div>
          <div style="position:relative">
            <button id="moreButton" type="button" class="icon-btn" title="More Actions\u2026" aria-label="More Actions"><svg width="16" height="16" viewBox="0 0 16 16"><circle fill="currentColor" cx="3.5" cy="8" r="1.5"/><circle fill="currentColor" cx="8" cy="8" r="1.5"/><circle fill="currentColor" cx="12.5" cy="8" r="1.5"/></svg></button>
            <div id="moreMenu" class="dropdown-menu hidden">
              <button id="menuToggleDevTools" class="dropdown-item">Developer Tools</button>
              <button id="menuToggleCssInspector" class="dropdown-item">Inspect Selected Element</button>
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
      <div class="workspace">
        <aside id="componentsPanel" class="components-panel hidden" aria-label="Components">
          <div class="components-header">
            <span class="components-title">Components</span>
            <button id="componentsClose" class="components-close" title="Hide panel">&times;</button>
          </div>
          <div id="componentsTree" class="components-tree">
            <div class="components-empty">Pick elements to see them here as a tree.</div>
          </div>
        </aside>
      <div id="stage" class="stage">
        <div id="emptyState" class="empty-state hidden">Enter a URL to start browsing.</div>
        <img
          id="browserFrame"
          draggable="false"
        />
        <div id="inspectHoverBox" class="inspect-hover-box hidden"></div>
        <div id="inspectTooltip" class="inspect-tooltip hidden"></div>
        
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
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function createNonce(): string {
  return Math.random().toString(36).slice(2);
}

function buildPortMappings(url: string): vscode.WebviewPortMapping[] {
  const common = [3000, 3001, 4200, 5173, 5174, 8000, 8080, 8443, 8888, 9000];
  const mappings = new Map<number, number>();
  for (const p of common) {
    mappings.set(p, p);
  }
  try {
    const parsed = new URL(url);
    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
    if (port && !isNaN(port)) {
      mappings.set(port, port);
    }
  } catch {
    // invalid URL, skip
  }
  return Array.from(mappings, ([webviewPort, extensionHostPort]) => ({
    webviewPort,
    extensionHostPort,
  }));
}

function isBlankPageUrl(url: string): boolean {
  return url.trim().toLowerCase() === "about:blank";
}

function isBlankPageTitle(title: string): boolean {
  return title.trim().toLowerCase() === "about:blank";
}

/**
 * Cursor builds often omit stable `aichat.focusInput`-style IDs. We mine the live
 * command registry for composer/chat-scoped commands that look like they move
 * focus into the prompt/input surface.
 */
function discoverComposerChatFocusCandidates(allCommands: readonly string[]): string[] {
  const scored: { id: string; score: number }[] = [];
  for (const id of allCommands) {
    if (!isComposerChatScopedCommand(id)) continue;
    if (isComposerChatNoiseCommand(id)) continue;
    let score = scoreFocusCandidate(id);
    if (/\bfocus\b/i.test(id)) score = Math.max(score, 58);
    if (/\.focus$/i.test(id)) score = Math.max(score, 62);
    if (/\b(activate|reveal)\w*View\b/i.test(id)) score += 28;
    if (score < 20) continue;
    scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((s) => s.id))];
}

function discoverComposerChatPasteCandidates(allCommands: readonly string[]): string[] {
  const scored: { id: string; score: number }[] = [];
  for (const id of allCommands) {
    if (!isComposerChatScopedCommand(id)) continue;
    if (isComposerChatNoiseCommand(id)) continue;
    const lower = id.toLowerCase();
    if (!/\bpaste\b|clipboard/.test(lower)) continue;
    let score = 20;
    if (/\bpaste\b/.test(lower)) score += 60;
    if (/input|composer|aichat|prompt|widget/.test(lower)) score += 25;
    scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((s) => s.id))];
}

function isComposerChatScopedCommand(id: string): boolean {
  return (
    /^composer\./i.test(id) ||
    /^aichat\./i.test(id) ||
    /^workbench\.action\.chat\./i.test(id) ||
    /panel\.chat/i.test(id)
  );
}

function isComposerChatNoiseCommand(id: string): boolean {
  return /backgroundcomposer|inlinechat|chatediting|inlineResourceAnchor|gotoDefinition|addFile|addSymbol|addfile|addsymbol|selectPrevious|selectNext|SubComposerTab|togglePeek|openFile|openfile|diff|peek|testNotification|testOpen|copyLink|addToChat|resetTrusted|removeFile|accept|discard|workingSet|canvas\.|conversationPicker|openCloud|openDevTools|archive|openMachine|forwardedPort|repositoryMismatch|getBackground|getCurrentWorkspace|showBackground|openBackground|createPR|checkoutLocally|applyChanges|revertFile|copyRequestId|toggleControl|createNewComposer|restartSetup|startSetup|checkOut|deletedFile/i.test(
    id,
  );
}

function scoreFocusCandidate(id: string): number {
  const lower = id.toLowerCase();
  let score = 0;
  if (/\bfocus\b/.test(lower)) score += 85;
  if (/input|prompt|widget|textarea|primary|mainEditor|typeDispatch/.test(lower)) score += 35;
  if (/^composer\./.test(lower)) score += 18;
  if (/^aichat\./.test(lower)) score += 15;
  if (/^workbench\.action\.chat\./.test(lower)) score += 12;
  // Openers / tab switches — not helpful for "focus prompt before paste"
  if (/\b(open|start|new|show|create|add|select|cancel|archive)\b/.test(lower) && !/\bfocus\b/.test(lower)) {
    score -= 40;
  }
  if (/startcomposerprompt|newchataction|newfollowup/.test(lower)) score -= 70;
  return score;
}

const IDE_AGENT_OPEN_COMMANDS = [
  // Cursor / Composer
  "composer.startComposerPrompt",
  "composer.startComposerPrompt2",
  "aichat.newchataction",
  "aichat.newchatactioneditor",
  "_workbench.action.composerNewSession",
  // VS Code core / Copilot Chat
  "workbench.action.chat.open",
  "workbench.action.chat.openInSidebar",
  "workbench.panel.chat.view.copilot.focus",
  "workbench.action.chat.newChat",
  // Antigravity
  "conversationPicker.showConversationPicker",
  "antigravity.openConversationPicker",
] as const;

const IDE_AGENT_FOCUS_COMMANDS = [
  // Cursor
  "aichat.focusInput",
  "composer.focusInput",
  "_aichat.focusInput",
  // VS Code core / Copilot Chat
  "workbench.action.chat.focusInput",
  "chat.action.focus",
] as const;

const IDE_AGENT_PASTE_COMMANDS = [
  // Cursor chat / composer paste handlers (if exposed)
  "aichat.input.paste",
  "composer.input.paste",
  // Generic paste — works in any focused Monaco-based editor (chat input is one)
  "editor.action.clipboardPasteAction",
] as const;

function formatDiagnosticLine(message: string, data?: unknown): string {
  const suffix = data === undefined ? "" : ` ${safeJson(data)}`;
  return `[${new Date().toISOString()}] ${message}${suffix}`;
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.trim() : String(error);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** SVG sub-elements: promoting picks to the owning `<svg>` avoids multi-KB `path d="..."` pastes. */
const SVG_INNER_TAGS_FOR_PROMOTION = new Set([
  "path",
  "circle",
  "rect",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "g",
  "text",
  "tspan",
  "textpath",
  "use",
  "defs",
  "clippath",
  "mask",
  "pattern",
  "lineargradient",
  "radialgradient",
  "stop",
  "image",
  "foreignobject",
  "marker",
  "view",
  "desc",
  "title",
  "metadata",
  "switch",
  "symbol",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "filter",
]);

interface AgentDomFormatConfig {
  maxAttributeValueLength: number;
  promoteSvgPicksToRoot: boolean;
}

function getAgentDomFormatConfig(): AgentDomFormatConfig {
  const c = vscode.workspace.getConfiguration("myPreview");
  const maxAttributeValueLength = c.get<number>("maxAgentAttributeLength", 120);
  return {
    maxAttributeValueLength: Math.min(2000, Math.max(32, maxAttributeValueLength)),
    promoteSvgPicksToRoot: c.get<boolean>("promoteSvgPicksToRoot", true),
  };
}

function truncateAttributeValueForAgent(name: string, value: string, max: number): string {
  if (max < 8 || value.length <= max) {
    const n = name.toLowerCase();
    const alwaysCap =
      n === "d" ||
      n === "style" ||
      n === "srcset" ||
      n === "points" ||
      (n === "src" && value.startsWith("data:"));
    if (!alwaysCap || value.length <= max) {
      return value;
    }
  }
  const sliceLen = Math.max(1, max - 1);
  return `${value.slice(0, sliceLen)}…`;
}

interface FormatElementDomOptions {
  tagName: string;
  outerHtml: string;
  cursorElementId: string;
  selector?: string;
  attributes?: Record<string, string>;
  box?: { top: number; left: number; width: number; height: number };
}

/**
 * Renders a picked element as 3 compact lines for direct paste into the
 * agent's chat input:
 *
 *   DOM Path: div.foo > div#bar > svg
 *   Position: top=60px, left=290px, width=272px, height=92px
 *   HTML Element: <svg ... data-cursor-element-id="cursor-el-1"></svg>
 *
 * The element's children are stripped — only the opening tag with its
 * attributes survives (plus a stable `data-cursor-element-id` so the agent
 * can reference each pick by id when several are sent).
 */
function formatElementDomForAgent(options: FormatElementDomOptions, format: AgentDomFormatConfig): string {
  const lines: string[] = [];
  if (options.selector) {
    lines.push(`DOM Path: ${options.selector}`);
  }
  if (options.box) {
    lines.push(
      `Position: top=${Math.round(options.box.top)}px, left=${Math.round(options.box.left)}px, width=${Math.round(options.box.width)}px, height=${Math.round(options.box.height)}px`,
    );
  }
  lines.push(`HTML Element: ${buildBareElementHtml(options, format)}`);
  return lines.join("\n");
}

function buildBareElementHtml(options: FormatElementDomOptions, format: AgentDomFormatConfig): string {
  const tag = options.tagName.toLowerCase() || "div";
  const attrs: Record<string, string> = options.attributes
    ? { ...options.attributes }
    : extractAttributesFromOuterHtml(options.outerHtml);
  attrs["data-cursor-element-id"] = options.cursorElementId;
  const attrString = Object.entries(attrs)
    .map(
      ([name, value]) =>
        `${name}="${escapeHtmlAttribute(truncateAttributeValueForAgent(name, value, format.maxAttributeValueLength))}"`,
    )
    .join(" ");
  return `<${tag}${attrString ? " " + attrString : ""}></${tag}>`;
}

function extractAttributesFromOuterHtml(outerHtml: string): Record<string, string> {
  const match = outerHtml.match(/^<\s*[a-zA-Z][^\s>/]*\s*([^>]*?)\s*\/?>/);
  if (!match) return {};
  const result: Record<string, string> = {};
  const attrRegex = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(match[1])) !== null) {
    const name = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    result[name] = value;
  }
  return result;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
