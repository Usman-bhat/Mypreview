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
exports.DocsResultsPanel = void 0;
const vscode = __importStar(require("vscode"));
class DocsResultsPanel {
    context;
    previewManager;
    panel;
    currentResponse;
    constructor(context, previewManager) {
        this.context = context;
        this.previewManager = previewManager;
    }
    show(response) {
        this.currentResponse = response;
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel("myDocs.results", "Docs Search", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
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
        this.panel.title = response.source ? `Docs Search • ${response.source.name}` : "Docs Search";
        this.panel.reveal(vscode.ViewColumn.Beside, true);
        this.postState();
    }
    dispose() {
        this.panel?.dispose();
    }
    async handleMessage(message) {
        switch (message.type) {
            case "docsResults.ready":
                this.postState();
                break;
            case "docsResults.openPreview":
                if (message.payload?.url) {
                    await this.previewManager.open(message.payload.url);
                }
                break;
            case "docsResults.openExternal":
                if (message.payload?.url) {
                    await vscode.env.openExternal(vscode.Uri.parse(message.payload.url));
                }
                break;
            default:
                break;
        }
    }
    postState() {
        if (!this.panel || !this.currentResponse) {
            return;
        }
        void this.panel.webview.postMessage({
            type: "docsResults.state",
            payload: this.currentResponse,
        });
    }
    renderHtml(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "docsResults.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "docsResults.css"));
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
    <title>Docs Search</title>
  </head>
  <body>
    <div class="shell">
      <header class="header">
        <h1>Docs Search</h1>
        <p id="summary"></p>
      </header>
      <section id="results" class="results"></section>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
    }
}
exports.DocsResultsPanel = DocsResultsPanel;
//# sourceMappingURL=docsResultsPanel.js.map