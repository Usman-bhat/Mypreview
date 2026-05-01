import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { rm, unlink } from "node:fs/promises";

import { registerBrowserBridgeSetupCommand } from "./browserBridgeSetup";
import { DocsSearchClient } from "./services/docsSearchClient";
import { WorkspaceState } from "./state/workspaceState";
import { SelectionContextStore } from "./state/selectionContextStore";
import { looksLikeUrl } from "./utils/url";
import { DocsChatPanel } from "./panels/docsChatPanel";
import { DocsResultsPanel } from "./panels/docsResultsPanel";
import { startBrowserBridgeServer } from "./bridge/browserBridgeServer";
import { LivePreviewManager } from "./panels/livePreviewManager";
import { forceCleanupBrowserProfiles } from "./profile/browserProfilePath";
import { ActionTreeDataProvider } from "./treeDataProvider";

async function cleanupStaleBrowserProfiles(): Promise<void> {
  try {
    const tempDir = os.tmpdir();
    const prefix = "vscode-browser-workbench-";
    
    // Clean up old browser profiles that might have stale lock files
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tempDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        const profilePath = path.join(tempDir, entry.name);
        
        try {
          // Check for stale lock files and remove them
          const lockFiles = ["SingletonLock", "DevToolsActivePort"];
          await Promise.all(
            lockFiles.map(file => 
              unlink(path.join(profilePath, file)).catch(() => undefined)
            )
          );
          
          // Also remove very old profile directories (older than 1 hour)
          const { stat } = await import("node:fs/promises");
          const stats = await stat(profilePath);
          const age = Date.now() - stats.mtime.getTime();
          
          if (age > 60 * 60 * 1000) { // 1 hour
            await rm(profilePath, { force: true, recursive: true });
          }
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }
  } catch (error) {
    // Ignore cleanup errors on startup
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Force cleanup existing browser profiles to resolve singleton lock conflicts
  void forceCleanupBrowserProfiles(context);
  
  // Clean up stale browser profiles on startup
  void cleanupStaleBrowserProfiles();
  
  const workspaceState = new WorkspaceState(context);
  const selectionContextStore = new SelectionContextStore();
  const previewManager = new LivePreviewManager(context, workspaceState, selectionContextStore);
  let docsClient = DocsSearchClient.fromConfiguration();
  const docsResultsPanel = new DocsResultsPanel(context, previewManager);
  const docsChatPanel = new DocsChatPanel(context, workspaceState, docsClient, previewManager);

  context.subscriptions.push(previewManager, docsResultsPanel, docsChatPanel, selectionContextStore);

  const actionTreeDataProvider = new ActionTreeDataProvider();
  vscode.window.registerTreeDataProvider("myPreview.actions", actionTreeDataProvider);

  registerBrowserBridgeSetupCommand(context);
  
  // Register cleanup command
  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.cleanupBrowserProfiles", async () => {
      await forceCleanupBrowserProfiles(context);
      vscode.window.showInformationMessage("Browser profiles cleaned up successfully");
    })
  );

  void startBrowserBridgeServer(context, previewManager).then((bridge) => {
    if (bridge) {
      context.subscriptions.push(bridge);
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("myDocs")) {
        docsClient = DocsSearchClient.fromConfiguration();
        docsChatPanel.setDocsClient(docsClient);
      }
    }),
  );

  // Open browser immediately with the last URL (or localhost:3000). No prompt.
  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.open", async () => {
      await previewManager.open();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.openFromSelection", async () => {
      const selected = resolveUrlFromSelection();
      const clipboard = selected ? undefined : (await vscode.env.clipboard.readText()).trim();
      const candidate = selected ?? (looksLikeUrl(clipboard) ? clipboard : undefined);

      if (!candidate) {
        void vscode.window.showInformationMessage(
          "No URL was found in the editor selection. VS Code does not expose terminal selection text, so the clipboard fallback only works if you copied the terminal URL first.",
        );
        return;
      }

      await previewManager.open(candidate);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.focus", () => {
      previewManager.focusCurrent();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.pinCurrent", async () => {
      await previewManager.pinCurrent();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.goBack", async () => {
      await previewManager.goBack();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.goForward", async () => {
      await previewManager.goForward();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.reload", async () => {
      await previewManager.reload(false);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.hardReload", async () => {
      await previewManager.reload(true);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.copyUrl", async () => {
      await previewManager.copyUrl();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.openExternal", async () => {
      await previewManager.openExternal();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.togglePickMode", async () => {
      await previewManager.togglePickMode();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.copyContextForAI", async () => {
      await previewManager.copyContextForAi();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.clearSelections", async () => {
      await previewManager.clearSelections();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.getSelectionContext", () => {
      return previewManager.getSelectionContext();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.showDiagnostics", async () => {
      await previewManager.showDiagnostics();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myDocs.search", async () => {
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
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Search failed.");
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myDocs.searchInDocs", async () => {
      try {
        const sources = docsClient.getConfiguredSources();

        if (!sources.length) {
          void vscode.window.showErrorMessage("Configure myDocs.defaultDocs before using scoped docs search.");
          return;
        }

        const picked = await vscode.window.showQuickPick(
          sources.map((source) => ({
            label: source.name,
            description: source.baseUrl,
            source,
          })),
          {
            title: "Choose a docs source",
            ignoreFocusOut: true,
          },
        );

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
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Scoped search failed.");
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("myDocs.openChat", async () => {
      await docsChatPanel.show();
    }),
  );
}

export function deactivate(): void {}

function resolveUrlFromSelection(): string | undefined {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return undefined;
  }

  const selection = editor.document.getText(editor.selection).trim();
  return looksLikeUrl(selection) ? selection : undefined;
}
