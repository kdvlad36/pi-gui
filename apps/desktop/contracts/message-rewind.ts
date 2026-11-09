import type { WorkspaceSessionTarget, DesktopAppState } from "./desktop-state";

export interface MessageRewindInput {
  readonly target: WorkspaceSessionTarget;
  readonly messageId: string;
}

export interface MessageRewindPlan {
  readonly id: string;
  readonly fileCount: number;
  /** Unknown is not the same as no changes. */
  readonly warning?: string;
  readonly restoreBlocked?: string;
}

export interface MessageRewindResult {
  readonly state: DesktopAppState;
  readonly editorText: string;
  readonly backupPath?: string;
  readonly draftBackupPath?: string;
}
