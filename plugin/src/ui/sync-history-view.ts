/**
 * Sync History sidebar view — pinnable tab showing recent sync changes.
 * Uses vanilla Obsidian ItemView for native sidebar look.
 */

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type { SyncHistoryEntry } from "../sync/sync-engine";
import type { SyncState } from "@vault-sync/shared/types";

export const SYNC_HISTORY_VIEW_TYPE = "advanced-sync-history";

const DIRECTION_ICON: Record<SyncHistoryEntry["direction"], string> = {
  upload:     "arrow-up",
  download:   "arrow-down",
  delete:     "trash-2",
  connect:    "wifi",
  disconnect: "wifi-off",
  error:      "alert-triangle",
};

const STATE_LABELS: Record<string, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting...",
  authenticating: "Authenticating...",
  syncing: "Syncing...",
  idle: "Connected",
  error: "Error",
};

export class SyncHistoryView extends ItemView {
  private getHistory: () => SyncHistoryEntry[];
  private getState: () => SyncState;
  private listEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    getHistory: () => SyncHistoryEntry[],
    getState: () => SyncState,
  ) {
    super(leaf);
    this.getHistory = getHistory;
    this.getState = getState;
  }

  getViewType(): string {
    return SYNC_HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Sync History";
  }

  getIcon(): string {
    return "refresh-cw";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("as-history-view");

    // Header
    const header = container.createDiv("as-history-view-header");
    header.createSpan({ text: "Sync History", cls: "as-history-view-title" });
    this.badgeEl = header.createDiv("as-history-view-badge");

    // List
    this.listEl = container.createDiv("as-history-view-list");

    this.refresh();
  }

  async onClose(): Promise<void> {
    // nothing to clean up
  }

  /** Re-render the view with current history data. Called externally on changes. */
  refresh(): void {
    if (!this.listEl || !this.badgeEl) return;

    // Update state badge
    const state = this.getState();
    this.badgeEl.empty();
    this.badgeEl.className = `as-history-view-badge as-state-${state}`;
    this.badgeEl.createSpan("as-history-view-badge-dot");
    this.badgeEl.createSpan({ text: STATE_LABELS[state] || state });

    // Update history list
    this.listEl.empty();
    const history = this.getHistory();

    if (history.length === 0) {
      this.listEl.createDiv({ text: "No changes yet", cls: "as-history-view-empty" });
      return;
    }

    for (const entry of history) {
      const row = this.listEl.createDiv("as-history-view-row");

      const icon = row.createSpan("as-history-view-icon");
      icon.addClass(`as-dir-${entry.direction}`);
      setIcon(icon, DIRECTION_ICON[entry.direction]);

      const info = row.createDiv("as-history-view-info");

      const nameRow = info.createDiv("as-history-view-name-row");
      nameRow.createSpan({ text: entry.filename, cls: "as-history-view-name" });
      if (entry.count > 1) {
        nameRow.createSpan({ text: `\u00d7${entry.count}`, cls: "as-history-view-count" });
      }

      if (["upload", "download", "delete"].includes(entry.direction)) {
        info.createDiv({ text: entry.path, cls: "as-history-view-path" });
      }

      row.createSpan({ text: this.formatTime(entry.timestamp), cls: "as-history-view-time" });
    }
  }

  private formatTime(ts: number): string {
    const diffMs = Date.now() - ts;
    const m = Math.floor(diffMs / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  }
}
