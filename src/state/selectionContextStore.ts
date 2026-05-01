import * as vscode from "vscode";

import { ElementReference } from "../browser/types";

export class SelectionContextStore {
  private readonly emitter = new vscode.EventEmitter<readonly ElementReference[]>();
  private selections: ElementReference[] = [];

  public readonly onDidChange = this.emitter.event;

  public getSelections(): readonly ElementReference[] {
    return this.selections;
  }

  public setSelections(selections: readonly ElementReference[]): void {
    this.selections = [...selections];
    this.emitter.fire(this.selections);
  }

  public clear(): void {
    this.setSelections([]);
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}
