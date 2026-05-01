import * as path from "node:path";

import * as vscode from "vscode";

/**
 * Helps users find browser-bridge.json (hidden under Cursor globalStorage) and
 * build the MCP snippet without hunting folders manually.
 */
export function registerBrowserBridgeSetupCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("myPreview.showBrowserBridgeSetup", async () => {
      const globalStorage = context.globalStorageUri;
      const bridgeJsonPath = path.join(globalStorage.fsPath, "browser-bridge.json");
      const mcpScriptPath = path.join(context.extensionPath, "mcp-server", "browser-mcp.mjs");

      const mcpServersBlock = {
        "inside-editor-browser": {
          command: "node",
          args: [mcpScriptPath],
          env: {
            BROWSER_BRIDGE_CONFIG: bridgeJsonPath,
          },
        },
      };

      const fullSnippet = JSON.stringify({ mcpServers: mcpServersBlock }, null, 2);

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "$(copy) Copy path: browser-bridge.json",
            description: bridgeJsonPath,
            id: "copy-bridge" as const,
          },
          {
            label: "$(copy) Copy path: browser-mcp.mjs",
            description: mcpScriptPath,
            id: "copy-mcp" as const,
          },
          {
            label: "$(clippy) Copy MCP block (paste into Cursor mcp.json)",
            description: "Includes mcpServers wrapper",
            id: "copy-snippet" as const,
          },
          {
            label: "$(file) Open browser-bridge.json in editor",
            description: "Requires bridge to have started at least once",
            id: "open-bridge" as const,
          },
          {
            label: "$(question) Where do I paste this in Cursor?",
            description: "Open Cursor Settings → MCP",
            id: "hint" as const,
          },
        ],
        {
          title: "Browser bridge & MCP setup",
          ignoreFocusOut: true,
        },
      );

      if (!choice || !("id" in choice)) {
        return;
      }

      switch (choice.id) {
        case "copy-bridge":
          await vscode.env.clipboard.writeText(bridgeJsonPath);
          void vscode.window.showInformationMessage("Copied path to browser-bridge.json");
          break;
        case "copy-mcp":
          await vscode.env.clipboard.writeText(mcpScriptPath);
          void vscode.window.showInformationMessage("Copied path to browser-mcp.mjs");
          break;
        case "copy-snippet":
          await vscode.env.clipboard.writeText(fullSnippet);
          void vscode.window.showInformationMessage(
            "Copied. In Cursor: Settings → MCP → Edit in settings, or open ~/.cursor/mcp.json and merge mcpServers.",
          );
          break;
        case "open-bridge": {
          const uri = vscode.Uri.file(bridgeJsonPath);
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
          } catch {
            void vscode.window.showWarningMessage(
              "browser-bridge.json was not found. Reload the window after activating the extension, and ensure myPreview.enableBrowserBridge is true.",
            );
          }
          break;
        }
        case "hint":
          void vscode.window.showInformationMessage(
            "Cursor: Cmd+, → search “MCP” → add server, or edit the file ~/.cursor/mcp.json and merge the copied mcpServers object. The bridge JSON is created when the extension starts.",
          );
          break;
      }
    }),
  );
}
