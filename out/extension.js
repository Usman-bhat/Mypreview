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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const promises_1 = require("node:fs/promises");
const browserBridgeSetup_1 = require("./browserBridgeSetup");
const docsSearchClient_1 = require("./services/docsSearchClient");
const workspaceState_1 = require("./state/workspaceState");
const selectionContextStore_1 = require("./state/selectionContextStore");
const url_1 = require("./utils/url");
const docsChatPanel_1 = require("./panels/docsChatPanel");
const docsResultsPanel_1 = require("./panels/docsResultsPanel");
const browserBridgeServer_1 = require("./bridge/browserBridgeServer");
const livePreviewManager_1 = require("./panels/livePreviewManager");
const browserProfilePath_1 = require("./profile/browserProfilePath");
const treeDataProvider_1 = require("./treeDataProvider");
async function cleanupStaleBrowserProfiles() {
    try {
        const tempDir = os.tmpdir();
        const prefix = "vscode-browser-workbench-";
        // Clean up old browser profiles that might have stale lock files
        const { readdir } = await Promise.resolve().then(() => __importStar(require("node:fs/promises")));
        const entries = await readdir(tempDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith(prefix)) {
                const profilePath = path.join(tempDir, entry.name);
                try {
                    // Check for stale lock files and remove them
                    const lockFiles = ["SingletonLock", "DevToolsActivePort"];
                    await Promise.all(lockFiles.map(file => (0, promises_1.unlink)(path.join(profilePath, file)).catch(() => undefined)));
                    // Also remove very old profile directories (older than 1 hour)
                    const { stat } = await Promise.resolve().then(() => __importStar(require("node:fs/promises")));
                    const stats = await stat(profilePath);
                    const age = Date.now() - stats.mtime.getTime();
                    if (age > 60 * 60 * 1000) { // 1 hour
                        await (0, promises_1.rm)(profilePath, { force: true, recursive: true });
                    }
                }
                catch (error) {
                    // Ignore cleanup errors
                }
            }
        }
    }
    catch (error) {
        // Ignore cleanup errors on startup
    }
}
function activate(context) {
    // Force cleanup existing browser profiles to resolve singleton lock conflicts
    void (0, browserProfilePath_1.forceCleanupBrowserProfiles)(context);
    // Clean up stale browser profiles on startup
    void cleanupStaleBrowserProfiles();
    const workspaceState = new workspaceState_1.WorkspaceState(context);
    const selectionContextStore = new selectionContextStore_1.SelectionContextStore();
    const previewManager = new livePreviewManager_1.LivePreviewManager(context, workspaceState, selectionContextStore);
    let docsClient = docsSearchClient_1.DocsSearchClient.fromConfiguration();
    const docsResultsPanel = new docsResultsPanel_1.DocsResultsPanel(context, previewManager);
    const docsChatPanel = new docsChatPanel_1.DocsChatPanel(context, workspaceState, docsClient, previewManager);
    context.subscriptions.push(previewManager, docsResultsPanel, docsChatPanel, selectionContextStore);
    const actionTreeDataProvider = new treeDataProvider_1.ActionTreeDataProvider();
    vscode.window.registerTreeDataProvider("myPreview.actions", actionTreeDataProvider);
    (0, browserBridgeSetup_1.registerBrowserBridgeSetupCommand)(context);
    // Register cleanup command
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.cleanupBrowserProfiles", async () => {
        await (0, browserProfilePath_1.forceCleanupBrowserProfiles)(context);
        vscode.window.showInformationMessage("Browser profiles cleaned up successfully");
    }));
    void (0, browserBridgeServer_1.startBrowserBridgeServer)(context, previewManager).then((bridge) => {
        if (bridge) {
            context.subscriptions.push(bridge);
        }
    });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("myDocs")) {
            docsClient = docsSearchClient_1.DocsSearchClient.fromConfiguration();
            docsChatPanel.setDocsClient(docsClient);
        }
    }));
    // Open browser immediately with the last URL (or localhost:3000). No prompt.
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.open", async () => {
        await previewManager.open();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.openFromSelection", async () => {
        const selected = resolveUrlFromSelection();
        const clipboard = selected ? undefined : (await vscode.env.clipboard.readText()).trim();
        const candidate = selected ?? ((0, url_1.looksLikeUrl)(clipboard) ? clipboard : undefined);
        if (!candidate) {
            void vscode.window.showInformationMessage("No URL was found in the editor selection. VS Code does not expose terminal selection text, so the clipboard fallback only works if you copied the terminal URL first.");
            return;
        }
        await previewManager.open(candidate);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.focus", () => {
        previewManager.focusCurrent();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.pinCurrent", async () => {
        await previewManager.pinCurrent();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.goBack", async () => {
        await previewManager.goBack();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.goForward", async () => {
        await previewManager.goForward();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.reload", async () => {
        await previewManager.reload(false);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.hardReload", async () => {
        await previewManager.reload(true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.copyUrl", async () => {
        await previewManager.copyUrl();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.openExternal", async () => {
        await previewManager.openExternal();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.togglePickMode", async () => {
        await previewManager.togglePickMode();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.copyContextForAI", async () => {
        await previewManager.copyContextForAi();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.clearSelections", async () => {
        await previewManager.clearSelections();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.getSelectionContext", () => {
        return previewManager.getSelectionContext();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.showDiagnostics", async () => {
        await previewManager.showDiagnostics();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myDocs.search", async () => {
        try {
            const query = await vscode.window.showInputBox({
                title: "Search docs or web",
                prompt: "Ask a docs or web question",
                ignoreFocusOut: true,
            });
            if (!query) {
                return;
            }
            const response = await docsClient.search({ query, limit: 8 });
            docsResultsPanel.show(response);
        }
        catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Search failed.");
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myDocs.searchInDocs", async () => {
        try {
            const sources = docsClient.getConfiguredSources();
            if (!sources.length) {
                void vscode.window.showErrorMessage("Configure myDocs.defaultDocs before using scoped docs search.");
                return;
            }
            const picked = await vscode.window.showQuickPick(sources.map((source) => ({
                label: source.name,
                description: source.baseUrl,
                source,
            })), {
                title: "Choose a docs source",
                ignoreFocusOut: true,
            });
            if (!picked) {
                return;
            }
            const query = await vscode.window.showInputBox({
                title: `Search in ${picked.source.name}`,
                prompt: "Enter a docs query",
                ignoreFocusOut: true,
            });
            if (!query) {
                return;
            }
            const response = await docsClient.search({
                query,
                source: picked.source,
                limit: 8,
            });
            docsResultsPanel.show(response);
        }
        catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Scoped search failed.");
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("myDocs.openChat", async () => {
        await docsChatPanel.show();
    }));
}
function deactivate() { }
function resolveUrlFromSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return undefined;
    }
    const selection = editor.document.getText(editor.selection).trim();
    return (0, url_1.looksLikeUrl)(selection) ? selection : undefined;
}
//# sourceMappingURL=extension.js.map