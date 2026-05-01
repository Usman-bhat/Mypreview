import * as vscode from "vscode";

import { ChatTurn, SerializedPreviewPanel } from "../types";

export class WorkspaceState {
  private static readonly lastPreviewUrlKey = "myPreview.lastUrl";
  private static readonly panelSnapshotsKey = "myPreview.panelSnapshots";
  private static readonly chatHistoryKey = "myDocs.chatHistory";

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getLastPreviewUrl(): string | undefined {
    return this.context.workspaceState.get<string>(WorkspaceState.lastPreviewUrlKey);
  }

  public async setLastPreviewUrl(url: string): Promise<void> {
    await this.context.workspaceState.update(WorkspaceState.lastPreviewUrlKey, url);
  }

  public getPanelSnapshots(): Record<string, SerializedPreviewPanel> {
    return this.context.workspaceState.get<Record<string, SerializedPreviewPanel>>(
      WorkspaceState.panelSnapshotsKey,
      {},
    );
  }

  public async upsertPanelSnapshot(snapshot: SerializedPreviewPanel): Promise<void> {
    const snapshots = this.getPanelSnapshots();
    snapshots[snapshot.id] = snapshot;
    await this.context.workspaceState.update(WorkspaceState.panelSnapshotsKey, snapshots);
  }

  public async deletePanelSnapshot(panelId: string): Promise<void> {
    const snapshots = this.getPanelSnapshots();
    delete snapshots[panelId];
    await this.context.workspaceState.update(WorkspaceState.panelSnapshotsKey, snapshots);
  }

  public getChatHistory(): ChatTurn[] {
    return this.context.workspaceState.get<ChatTurn[]>(WorkspaceState.chatHistoryKey, []);
  }

  public async setChatHistory(history: ChatTurn[]): Promise<void> {
    await this.context.workspaceState.update(WorkspaceState.chatHistoryKey, history);
  }
}
