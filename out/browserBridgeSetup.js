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
exports.registerBrowserBridgeSetupCommand = registerBrowserBridgeSetupCommand;
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
/**
 * Helps users find browser-bridge.json (hidden under Cursor globalStorage) and
 * build the MCP snippet without hunting folders manually.
 */
function registerBrowserBridgeSetupCommand(context) {
    context.subscriptions.push(vscode.commands.registerCommand("myPreview.showBrowserBridgeSetup", async () => {
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
        const choice = await vscode.window.showQuickPick([
            {
                label: "$(copy) Copy path: browser-bridge.json",
                description: bridgeJsonPath,
                id: "copy-bridge",
            },
            {
                label: "$(copy) Copy path: browser-mcp.mjs",
                description: mcpScriptPath,
                id: "copy-mcp",
            },
            {
                label: "$(clippy) Copy MCP block (paste into Cursor mcp.json)",
                description: "Includes mcpServers wrapper",
                id: "copy-snippet",
            },
            {
                label: "$(file) Open browser-bridge.json in editor",
                description: "Requires bridge to have started at least once",
                id: "open-bridge",
            },
            {
                label: "$(question) Where do I paste this in Cursor?",
                description: "Open Cursor Settings → MCP",
                id: "hint",
            },
        ], {
            title: "Browser bridge & MCP setup",
            ignoreFocusOut: true,
        });
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
                void vscode.window.showInformationMessage("Copied. In Cursor: Settings → MCP → Edit in settings, or open ~/.cursor/mcp.json and merge mcpServers.");
                break;
            case "open-bridge": {
                const uri = vscode.Uri.file(bridgeJsonPath);
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                }
                catch {
                    void vscode.window.showWarningMessage("browser-bridge.json was not found. Reload the window after activating the extension, and ensure myPreview.enableBrowserBridge is true.");
                }
                break;
            }
            case "hint":
                void vscode.window.showInformationMessage("Cursor: Cmd+, → search “MCP” → add server, or edit the file ~/.cursor/mcp.json and merge the copied mcpServers object. The bridge JSON is created when the extension starts.");
                break;
        }
    }));
}
//# sourceMappingURL=browserBridgeSetup.js.map