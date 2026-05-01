"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceState = void 0;
class WorkspaceState {
    context;
    static lastPreviewUrlKey = "myPreview.lastUrl";
    static panelSnapshotsKey = "myPreview.panelSnapshots";
    static chatHistoryKey = "myDocs.chatHistory";
    constructor(context) {
        this.context = context;
    }
    getLastPreviewUrl() {
        return this.context.workspaceState.get(WorkspaceState.lastPreviewUrlKey);
    }
    async setLastPreviewUrl(url) {
        await this.context.workspaceState.update(WorkspaceState.lastPreviewUrlKey, url);
    }
    getPanelSnapshots() {
        return this.context.workspaceState.get(WorkspaceState.panelSnapshotsKey, {});
    }
    async upsertPanelSnapshot(snapshot) {
        const snapshots = this.getPanelSnapshots();
        snapshots[snapshot.id] = snapshot;
        await this.context.workspaceState.update(WorkspaceState.panelSnapshotsKey, snapshots);
    }
    async deletePanelSnapshot(panelId) {
        const snapshots = this.getPanelSnapshots();
        delete snapshots[panelId];
        await this.context.workspaceState.update(WorkspaceState.panelSnapshotsKey, snapshots);
    }
    getChatHistory() {
        return this.context.workspaceState.get(WorkspaceState.chatHistoryKey, []);
    }
    async setChatHistory(history) {
        await this.context.workspaceState.update(WorkspaceState.chatHistoryKey, history);
    }
}
exports.WorkspaceState = WorkspaceState;
//# sourceMappingURL=workspaceState.js.map