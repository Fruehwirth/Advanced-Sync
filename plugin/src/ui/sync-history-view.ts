/**
 * Sync History sidebar view — pinnable tab showing recent sync changes.
 * Shows live progress during sync and auto-updates on every file change.
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
  connecting:   "Connecting...",
  authenticating: "Authenticating...",
  syncing:      "Syncing...",
  idle:         "Connected",
  error:        "Error",
};

export class SyncHistoryView extends ItemView {
  private getHistory: () => SyncHistoryEntry[];
  private getState: () => SyncState;
  private badgeEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressBarFill: HTMLElement | null = null;
  private progressTextEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    getHistory: () => SyncHistoryEntry[],
    getState: () => SyncState,
  ) {
    super(leaf);
    this.getHistory = getHistory;
    this.getState = getState;
  }

  getViewType(): string { return SYNC_HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return "Sync History"; }
  getIcon(): string { return "refresh-cw"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("as-history-view");

    // Header: title + state badge
    const header = container.createDiv("as-history-view-header");
    header.createSpan({ text: "Recent Changes", cls: "as-history-view-title" });
    this.badgeEl = header.createDiv("as-history-view-badge");

    // Progress bar — shown only while syncing
    this.progressEl = container.createDiv("as-history-view-progress");
    const progressInner = this.progressEl.createDiv("as-history-view-progress-inner");
    this.progressBarFill = progressInner.createDiv("as-history-view-progress-bar");
    this.progressTextEl = this.progressEl.createDiv("as-history-view-progress-text");
    this.progressEl.style.display = "none";

    // History list
    this.listEl = container.createDiv("as-history-view-list");

    this.refresh();
  }

  async onClose(): Promise<void> {}

  /** Update the live progress display during sync. */
  setProgress(current: number, total: number, detail: string): void {
    if (!this.progressEl || !this.progressTextEl || !this.progressBarFill) return;
    this.progressEl.style.display = "block";
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    this.progressBarFill.style.width = `${pct}%`;
    const remaining = total - current;
    this.progressTextEl.textContent = remaining > 0
      ? `${remaining} file${remaining !== 1 ? "s" : ""} remaining — ${detail}`
      : detail;
  }

  /** Hide the progress area (called when sync completes or errors). */
  clearProgress(): void {
    if (!this.progressEl) return;
    this.progressEl.style.display = "none";
    if (this.progressBarFill) this.progressBarFill.style.width = "0%";
  }

  /** Re-render badge + history list. Called externally on every state/history change. */
  refresh(): void {
    if (!this.listEl || !this.badgeEl) return;

    // State badge
    const state = this.getState();
    this.badgeEl.empty();
    this.badgeEl.className = `as-history-view-badge as-state-${state}`;
    this.badgeEl.createSpan("as-history-view-badge-dot");
    this.badgeEl.createSpan({ text: STATE_LABELS[state] || state });

    // Hide progress bar when not syncing
    if (state !== "syncing" && state !== "connecting" && state !== "authenticating") {
      this.clearProgress();
    }

    // History list
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
