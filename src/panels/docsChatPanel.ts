import * as vscode from "vscode";

import { composeAnswer } from "../services/answerComposer";
import { DocsSearchClient } from "../services/docsSearchClient";
import { WorkspaceState } from "../state/workspaceState";
import { ChatTurn, DocSource } from "../types";
import { LivePreviewManager } from "./livePreviewManager";

interface DocsChatMessage {
  type: string;
  payload?: {
    question?: string;
    sourceName?: string;
    url?: string;
  };
}

export class DocsChatPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private busy = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceState: WorkspaceState,
    private docsClient: DocsSearchClient,
    private readonly previewManager: LivePreviewManager,
  ) {}

  public setDocsClient(docsClient: DocsSearchClient): void {
    this.docsClient = docsClient;
    this.postState();
  }

  public async show(): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "myDocs.chat",
        "Docs Chat",
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

      this.panel.webview.onDidReceiveMessage((message: DocsChatMessage) => {
        void this.handleMessage(message);
      });
    }

    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.postState();
  }

  public dispose(): void {
    this.panel?.dispose();
  }

  private async handleMessage(message: DocsChatMessage): Promise<void> {
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

  private async ask(question: string, sourceName?: string): Promise<void> {
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
      const composed = composeAnswer(response);
      const history = this.workspaceState.getChatHistory();
      const turn: ChatTurn = {
        id: `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        question: composed.question,
        answerSummary: composed.answerSummary,
        citations: composed.citations,
        sourceName: composed.sourceName,
        createdAt: new Date().toISOString(),
      };

      history.unshift(turn);
      await this.workspaceState.setChatHistory(history.slice(0, 30));
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : "Docs Chat failed to search the configured endpoint.",
      );
    } finally {
      this.busy = false;
      this.postState();
    }
  }

  private postState(): void {
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

  private renderHtml(webview: vscode.Webview): string {
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
