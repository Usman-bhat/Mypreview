/**
 * Antigravity adapter sketch.
 *
 * Why this file lives outside src/:
 * - the primary deliverable is a standard VS Code extension build
 * - Antigravity's public extension SDK is not clearly documented enough to compile
 *   against a real package here
 * - the shared logic stays provider-agnostic, so this file shows how to wire the same
 *   search client and preview UX to Antigravity when the relevant APIs are available
 *
 * The screenshot supplied by the user shows Antigravity already exposing a native
 * in-editor browser surface with actions like take screenshot, hard reload, and copy URL.
 * If Antigravity exposes that browser panel to extensions, prefer that over a webview iframe.
 */

type AntigravityCommandHandler = (...args: unknown[]) => Promise<void> | void;

interface AntigravityQuickPickItem {
  label: string;
  description?: string;
}

interface AntigravityBrowserPanel {
  setUrl(url: string): Promise<void>;
  reload(): Promise<void>;
  reveal(): Promise<void>;
  openExternal(url: string): Promise<void>;
}

interface AntigravityWindowApi {
  showInputBox(options: { title: string; prompt: string; value?: string }): Promise<string | undefined>;
  showQuickPick(items: AntigravityQuickPickItem[], options: { title: string }): Promise<AntigravityQuickPickItem | undefined>;
  createBrowserPanel?(options: { title: string; url: string }): Promise<AntigravityBrowserPanel>;
  createWebviewPanel?(options: { title: string; html: string }): Promise<void>;
  showError(message: string): Promise<void>;
}

interface AntigravityCommandsApi {
  registerCommand(command: string, handler: AntigravityCommandHandler): void;
}

interface AntigravityMemento {
  get<T>(key: string, fallback?: T): T | undefined;
  update<T>(key: string, value: T): Promise<void>;
}

interface AntigravityApi {
  window: AntigravityWindowApi;
  commands: AntigravityCommandsApi;
  workspaceState: AntigravityMemento;
}

/**
 * This skeleton intentionally mirrors the VS Code commands:
 * - myPreview.open
 * - myDocs.search
 *
 * Replace the fake search call with the shared HTTP client from src/services/docsSearchClient.ts
 * once the Antigravity extension runtime can import it.
 */
export function activateAntigravity(api: AntigravityApi): void {
  api.commands.registerCommand("myPreview.open", async () => {
    const rememberedUrl = api.workspaceState.get<string>("myPreview.lastUrl", "http://localhost:3000");
    const rawUrl = await api.window.showInputBox({
      title: "Open Live Preview",
      prompt: "Enter the URL to open in Antigravity's browser",
      value: rememberedUrl,
    });

    if (!rawUrl) {
      return;
    }

    await api.workspaceState.update("myPreview.lastUrl", rawUrl);

    if (api.window.createBrowserPanel) {
      const browser = await api.window.createBrowserPanel({
        title: "Live Preview",
        url: rawUrl,
      });
      await browser.reveal();
      return;
    }

    if (api.window.createWebviewPanel) {
      await api.window.createWebviewPanel({
        title: "Live Preview",
        html: `<iframe src="${rawUrl}" style="width:100%;height:100%;border:0;"></iframe>`,
      });
      return;
    }

    await api.window.showError(
      "Antigravity did not expose a browser or webview panel API. Open the URL externally as a fallback.",
    );
  });

  api.commands.registerCommand("myDocs.search", async () => {
    const query = await api.window.showInputBox({
      title: "Search Docs Or Web",
      prompt: "Enter a docs query",
    });

    if (!query) {
      return;
    }

    /**
     * Replace this mock block with the same provider-agnostic HTTP client used by the VS Code build.
     * The panel rendering can stay the same regardless of the backend.
     */
    const mockedResults = [
      {
        label: `Open first result for "${query}"`,
        description: "https://example.com/docs/result-1",
      },
      {
        label: `Open second result for "${query}"`,
        description: "https://example.com/docs/result-2",
      },
    ];

    const picked = await api.window.showQuickPick(mockedResults, {
      title: "Search Results",
    });

    if (!picked?.description) {
      return;
    }

    if (api.window.createBrowserPanel) {
      const browser = await api.window.createBrowserPanel({
        title: picked.label,
        url: picked.description,
      });
      await browser.reveal();
      return;
    }

    if (api.window.createWebviewPanel) {
      await api.window.createWebviewPanel({
        title: picked.label,
        html: `<iframe src="${picked.description}" style="width:100%;height:100%;border:0;"></iframe>`,
      });
    }
  });
}
