import * as vscode from "vscode";

import { DocsSearchResponse } from "../types";
import { LivePreviewManager } from "./livePreviewManager";

interface DocsResultsViewMessage {
  type: string;
  payload?: {
    url?: string;
  };
}

export class DocsResultsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private currentResponse: DocsSearchResponse | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly previewManager: LivePreviewManager,
  ) {}

  public show(response: DocsSearchResponse): void {
    this.currentResponse = response;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "myDocs.results",
        "Docs Search",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
        },
      );

      this.panel.webview.html = this.renderHtml(this.panel.webview);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });

      this.panel.webview.onDidReceiveMessage((message: DocsResultsViewMessage) => {
        void this.handleMessage(message);
      });
    }

    this.panel.title = response.source ? `Docs Search • ${response.source.name}` : "Docs Search";
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.postState();
  }

  public dispose(): void {
    this.panel?.dispose();
  }

  private async handleMessage(message: DocsResultsViewMessage): Promise<void> {
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

  private postState(): void {
    if (!this.panel || !this.currentResponse) {
      return;
    }

    void this.panel.webview.postMessage({
      type: "docsResults.state",
      payload: this.currentResponse,
    });
  }

  private renderHtml(webview: vscode.Webview): string {
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
