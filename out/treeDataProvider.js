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
exports.ActionTreeDataProvider = void 0;
const vscode = __importStar(require("vscode"));
class ActionTreeDataProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (element) {
            return Promise.resolve([]);
        }
        else {
            const openBrowser = new vscode.TreeItem("Open Browser Workbench", vscode.TreeItemCollapsibleState.None);
            openBrowser.command = {
                command: "myPreview.open",
                title: "Open Browser Workbench"
            };
            openBrowser.iconPath = new vscode.ThemeIcon("browser");
            const openDocsChat = new vscode.TreeItem("Open Docs Chat", vscode.TreeItemCollapsibleState.None);
            openDocsChat.command = {
                command: "myDocs.openChat",
                title: "Open Docs Chat"
            };
            openDocsChat.iconPath = new vscode.ThemeIcon("comment-discussion");
            const searchDocs = new vscode.TreeItem("Search Docs", vscode.TreeItemCollapsibleState.None);
            searchDocs.command = {
                command: "myDocs.search",
                title: "Search Docs"
            };
            searchDocs.iconPath = new vscode.ThemeIcon("search");
            return Promise.resolve([openBrowser, openDocsChat, searchDocs]);
        }
    }
}
exports.ActionTreeDataProvider = ActionTreeDataProvider;
//# sourceMappingURL=treeDataProvider.js.map