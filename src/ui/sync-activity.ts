/**
 * Unified sync activity renderer — used by both the sidebar view
 * and the settings dashboard to display live sync progress and history.
 */

import { setIcon } from "obsidian";
import type { SyncHistoryEntry, SyncActivityItem } from "../sync/sync-engine";
import type { SyncState } from "@vault-sync/shared/types";

const DIRECTION_ICON: Record<string, string> = {
  upload:     "arrow-up",
  download:   "arrow-down",
  delete:     "trash-2",
  create:     "plus",
  connect:    "wifi",
  disconnect: "wifi-off",
  error:      "alert-triangle",
};

const STATE_LABELS: Record<string, string> = {
  disconnected:   "Disconnected",
  connecting:     "Connecting...",
  authenticating: "Authenticating...",
  syncing:        "Syncing...",
  idle:           "Connected",
  error:          "Error",
};

const STATUS_ICON: Record<string, string> = {
  pending:   "clock",
  active:    "loader",
  completed: "check",
  failed:    "alert-triangle",
};

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

export interface SyncActivityRendererOptions {
  getActiveItems: () => SyncActivityItem[];
  getHistory: () => SyncHistoryEntry[];
  getState: () => SyncState;
  maxHistoryItems?: number;
  /** If provided, the status badge is rendered here instead of inside the scroll container. */
  badgeContainer?: HTMLElement;
  /** Called when the user clicks a file entry to navigate to it. */
  onNavigate?: (path: string) => void;
  /** Returns true if the plugin has a server configured. */
  isConfigured?: () => boolean;
}

export class SyncActivityRenderer {
  private container: HTMLElement;
  private options: SyncActivityRendererOptions;
  private badgeEl: HTMLElement | null = null;
  private activeSection: HTMLElement | null = null;
  private historySection: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressBarFill: HTMLElement | null = null;
  private progressTextEl: HTMLElement | null = null;

  constructor(container: HTMLElement, options: SyncActivityRendererOptions) {
    this.container = container;
    this.options = options;
  }

  /** Full re-render (state badge + active items + history). */
  render(): void {
    this.container.empty();

    // State badge — render in the provided external slot, or inline at the top
    this.badgeEl = this.options.badgeContainer ?? this.container.createDiv("as-activity-badge-container");
    this.renderBadge();

    // Progress bar
    this.progressEl = this.container.createDiv("as-history-view-progress");
    const progressInner = this.progressEl.createDiv("as-history-view-progress-inner");
    this.progressBarFill = progressInner.createDiv("as-history-view-progress-bar");
    this.progressTextEl = this.progressEl.createDiv("as-history-view-progress-text");
    this.progressEl.style.display = "none";

    // Active sync section
    this.activeSection = this.container.createDiv("as-activity-active");
    this.renderActiveItems();

    // History section
    this.historySection = this.container.createDiv("as-activity-history");
    this.renderHistory();
  }

  /** Incremental update: just refresh active items section. */
  refreshActive(): void {
    if (this.activeSection) {
      this.renderActiveItems();
    }
    this.renderBadge();
  }

  /** Incremental update: just refresh history section. */
  refreshHistory(): void {
    if (this.historySection) {
      this.renderHistory();
    }
  }

  /** Update progress bar. */
  setProgress(current: number, total: number, detail: string): void {
    if (!this.progressEl || !this.progressBarFill || !this.progressTextEl) return;
    if (total === 0 || current >= total) {
      this.progressEl.style.display = "none";
      this.progressBarFill.style.width = "0%";
      return;
    }
    this.progressEl.style.display = "block";
    const pct = Math.round((current / total) * 100);
    this.progressBarFill.style.width = `${pct}%`;
    const remaining = total - current;
    this.progressTextEl.textContent = remaining > 0
      ? `${remaining} file${remaining !== 1 ? "s" : ""} remaining — ${detail}`
      : detail;
  }

  /** Clear progress bar. */
  clearProgress(): void {
    if (!this.progressEl) return;
    this.progressEl.style.display = "none";
    if (this.progressBarFill) this.progressBarFill.style.width = "0%";
  }

  /** Destroy and clean up. */
  destroy(): void {
    this.container.empty();
    // If the badge lives in an external container, clear it too
    if (this.options.badgeContainer) this.options.badgeContainer.empty();
    this.badgeEl = null;
    this.activeSection = null;
    this.historySection = null;
    this.progressEl = null;
    this.progressBarFill = null;
    this.progressTextEl = null;
  }

  private renderBadge(): void {
    if (!this.badgeEl) return;
    const state = this.options.getState();
    this.badgeEl.empty();
    const badge = this.badgeEl.createDiv(`as-history-view-badge as-state-${state}`);
    badge.createSpan("as-history-view-badge-dot");
    badge.createSpan({ text: STATE_LABELS[state] || state });

    // Hide progress when not syncing
    if (state !== "syncing" && state !== "connecting" && state !== "authenticating") {
      this.clearProgress();
    }
  }

  private renderActiveItems(): void {
    if (!this.activeSection) return;
    this.activeSection.empty();

    const items = this.options.getActiveItems();
    const activeCount = items.filter(i => i.status === "active" || i.status === "pending").length;

    if (activeCount === 0) {
      this.activeSection.style.display = "none";
      return;
    }

    this.activeSection.style.display = "block";

    // Overall progress summary
    const completed = items.filter(i => i.status === "completed").length;
    const total = items.length;
    const summaryEl = this.activeSection.createDiv("as-activity-summary");
    summaryEl.textContent = `Syncing ${completed} / ${total} files`;

    // Per-file rows (show active and pending items, limit display)
    const visibleItems = items.filter(i => i.status !== "completed").slice(0, 10);
    for (const item of visibleItems) {
      const row = this.activeSection.createDiv(`as-activity-row as-activity-${item.status}`);

      const statusIcon = row.createSpan("as-activity-status-icon");
      setIcon(statusIcon, STATUS_ICON[item.status] || "circle");
      if (item.status === "active") {
        statusIcon.addClass("as-spin");
      }

      const info = row.createDiv("as-activity-info");
      const nameRow = info.createDiv("as-activity-name-row");
      nameRow.createSpan({ text: item.filename, cls: "as-activity-name" });

      if (item.fileSize) {
        nameRow.createSpan({ text: formatSize(item.fileSize), cls: "as-activity-size" });
      }

      if (item.error) {
        info.createDiv({ text: item.error, cls: "as-activity-error" });
      }

      const dirIcon = row.createSpan("as-history-view-icon");
      dirIcon.addClass(`as-dir-${item.direction}`);
      setIcon(dirIcon, DIRECTION_ICON[item.direction] || "circle");
    }
  }

  private renderHistory(): void {
    if (!this.historySection) return;
    this.historySection.empty();

    const history = this.options.getHistory();
    const maxItems = this.options.maxHistoryItems ?? 50;

    if (history.length === 0) {
      // Show contextual empty state
      const state = this.options.getState();
      const configured = this.options.isConfigured?.() ?? true;
      if (!configured && state === "disconnected") {
        this.historySection.createDiv({
          text: "Set up a server in Settings to see sync activity",
          cls: "as-history-view-empty",
        });
      } else {
        this.historySection.createDiv({ text: "No changes yet", cls: "as-history-view-empty" });
      }
      return;
    }

    const isFileDirection = (d: string) => ["upload", "download", "delete", "create"].includes(d);

    for (const entry of history.slice(0, maxItems)) {
      const rowClasses = ["as-history-view-row"];
      if (entry.pending) rowClasses.push("as-history-view-row-pending");
      if (isFileDirection(entry.direction) && this.options.onNavigate && !entry.pending && entry.direction !== "delete") {
        rowClasses.push("as-history-view-row-clickable");
      }
      const row = this.historySection.createDiv(rowClasses.join(" "));

      // Click-to-navigate for file entries (not deletes, not pending)
      if (isFileDirection(entry.direction) && this.options.onNavigate && !entry.pending && entry.direction !== "delete") {
        const navigate = this.options.onNavigate;
        row.addEventListener("click", () => navigate(entry.path));
      }

      const icon = row.createSpan("as-history-view-icon");
      icon.addClass(`as-dir-${entry.direction}`);
      setIcon(icon, DIRECTION_ICON[entry.direction] || "arrow-right");

      const info = row.createDiv("as-history-view-info");
      const nameRow = info.createDiv("as-history-view-name-row");

      // Split filename and extension
      const dotIdx = entry.filename.lastIndexOf(".");
      const hasExt = dotIdx > 0;
      const displayName = hasExt ? entry.filename.substring(0, dotIdx) : entry.filename;
      const ext = hasExt ? entry.filename.substring(dotIdx + 1) : "";

      nameRow.createSpan({ text: displayName, cls: "as-history-view-name" });

      // Show extension badge for non-.md files
      if (hasExt && ext.toLowerCase() !== "md") {
        nameRow.createSpan({ text: ext.toUpperCase(), cls: "as-history-view-ext" });
      }

      if (entry.count > 1) {
        const countEl = nameRow.createSpan({ text: `\u00d7${entry.count}`, cls: "as-history-view-count as-history-view-count-flash" });
        // Remove flash class after animation completes
        countEl.addEventListener("animationend", () => countEl.removeClass("as-history-view-count-flash"), { once: true });
      }

      if (isFileDirection(entry.direction)) {
        info.createDiv({ text: entry.path, cls: "as-history-view-path" });
      }

      if (entry.pending) {
        row.createSpan({ text: "pending", cls: "as-history-view-time as-history-view-time-pending" });
      } else {
        row.createSpan({ text: formatTimeAgo(entry.timestamp), cls: "as-history-view-time" });
      }
    }
  }
}
