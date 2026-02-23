/**
 * Sync History sidebar view — pinnable tab showing recent sync changes.
 * Uses the unified SyncActivityRenderer for consistent display.
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import type { SyncHistoryEntry, SyncActivityItem } from "../sync/sync-engine";
import type { SyncState } from "@vault-sync/shared/types";
import { SyncActivityRenderer } from "./sync-activity";

export const SYNC_HISTORY_VIEW_TYPE = "advanced-sync-history";

export class SyncHistoryView extends ItemView {
  private getHistory: () => SyncHistoryEntry[];
  private getState: () => SyncState;
  private getActiveItems: () => SyncActivityItem[];
  private onNavigate?: (path: string) => void;
  private isConfigured?: () => boolean;
  private renderer: SyncActivityRenderer | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    getHistory: () => SyncHistoryEntry[],
    getState: () => SyncState,
    getActiveItems: () => SyncActivityItem[],
    onNavigate?: (path: string) => void,
    isConfigured?: () => boolean,
  ) {
    super(leaf);
    this.getHistory = getHistory;
    this.getState = getState;
    this.getActiveItems = getActiveItems;
    this.onNavigate = onNavigate;
    this.isConfigured = isConfigured;
  }

  getViewType(): string { return SYNC_HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return "Sync History"; }
  getIcon(): string { return "refresh-cw"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("as-history-view");

    // Header — title on the left, status badge on the right
    const header = container.createDiv("as-history-view-header");
    header.createSpan({ text: "Recent Changes", cls: "as-history-view-title" });
    const badgeSlot = header.createDiv();

    // Renderer container
    const rendererContainer = container.createDiv("as-history-view-content");

    this.renderer = new SyncActivityRenderer(rendererContainer, {
      getActiveItems: this.getActiveItems,
      getHistory: this.getHistory,
      getState: this.getState,
      badgeContainer: badgeSlot,
      onNavigate: this.onNavigate,
      isConfigured: this.isConfigured,
    });
    this.renderer.render();
  }

  async onClose(): Promise<void> {
    this.renderer?.destroy();
    this.renderer = null;
  }

  /** Update the live progress display during sync. */
  setProgress(current: number, total: number, detail: string): void {
    this.renderer?.setProgress(current, total, detail);
  }

  /** Hide the progress area (called when sync completes or errors). */
  clearProgress(): void {
    this.renderer?.clearProgress();
  }

  /** Re-render. Called externally on every state/history change. */
  refresh(): void {
    this.renderer?.render();
  }

  /** Incremental update: just refresh active items. */
  refreshActive(): void {
    this.renderer?.refreshActive();
  }
}
