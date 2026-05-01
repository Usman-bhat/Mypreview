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
exports.DocsChatPanel = void 0;
const vscode = __importStar(require("vscode"));
const answerComposer_1 = require("../services/answerComposer");
class DocsChatPanel {
    context;
    workspaceState;
    docsClient;
    previewManager;
    panel;
    busy = false;
    constructor(context, workspaceState, docsClient, previewManager) {
        this.context = context;
        this.workspaceState = workspaceState;
        this.docsClient = docsClient;
        this.previewManager = previewManager;
    }
    setDocsClient(docsClient) {
        this.docsClient = docsClient;
        this.postState();
    }
    async show() {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel("myDocs.chat", "Docs Chat", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
            });
            this.panel.webview.html = this.renderHtml(this.panel.webview);
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
            this.panel.webview.onDidReceiveMessage((message) => {
                void this.handleMessage(message);
            });
        }
        this.panel.reveal(vscode.ViewColumn.Beside, true);
        this.postState();
    }
    dispose() {
        this.panel?.dispose();
    }
    async handleMessage(message) {
        switch (message.type) {
            case "docsChat.ready":
                this.postState();
                break;
            case "docsChat.ask":
                await this.ask(message.payload?.question ?? "", message.payload?.sourceName);
                break;
            case "docsChat.openPreview":
                if (message.payload?.url) {
                    await this.previewManager.open(message.payload.url);
                }
                break;
            default:
                break;
        }
    }
    async ask(question, sourceName) {
        const trimmed = question.trim();
        if (!trimmed || this.busy) {
            return;
        }
        this.busy = true;
        this.postState();
        try {
            const source = this.docsClient.getConfiguredSources().find((item) => item.name === sourceName);
            const response = await this.docsClient.search({
                query: trimmed,
                source,
                limit: 5,
            });
            const composed = (0, answerComposer_1.composeAnswer)(response);
            const history = this.workspaceState.getChatHistory();
            const turn = {
                id: `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
                question: composed.question,
                answerSummary: composed.answerSummary,
                citations: composed.citations,
                sourceName: composed.sourceName,
                createdAt: new Date().toISOString(),
            };
            history.unshift(turn);
            await this.workspaceState.setChatHistory(history.slice(0, 30));
        }
        catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Docs Chat failed to search the configured endpoint.");
        }
        finally {
            this.busy = false;
            this.postState();
        }
    }
    postState() {
        if (!this.panel) {
            return;
        }
        const payload = {
            busy: this.busy,
            history: this.workspaceState.getChatHistory(),
            sources: this.docsClient.getConfiguredSources(),
        };
        void this.panel.webview.postMessage({
            type: "docsChat.state",
            payload,
        });
    }
    renderHtml(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "docsChat.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "docsChat.css"));
        const nonce = Math.random().toString(36).slice(2);
        return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Docs Chat</title>
  </head>
  <body>
    <div class="shell">
      <aside class="history-pane">
        <div class="pane-header">
          <h1>Docs Chat</h1>
          <p>Use docs search like a lightweight in-editor @web / @Doc flow.</p>
        </div>
        <div id="history" class="history"></div>
      </aside>
      <section class="composer-pane">
        <div class="composer-card">
          <label for="sourceSelect">Source</label>
          <select id="sourceSelect"></select>
          <label for="questionInput">Ask a question</label>
          <textarea id="questionInput" rows="6" placeholder="How do I build a layout with container queries?"></textarea>
          <button id="askButton">Search and Answer</button>
          <p id="busyText" class="busy hidden">Searching…</p>
        </div>
      </section>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
    }
}
exports.DocsChatPanel = DocsChatPanel;
//# sourceMappingURL=docsChatPanel.js.map