import * as vscode from 'vscode';

export class ActionTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (element) {
      return Promise.resolve([]);
    } else {
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
