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

/** Extensions produced by Advanced Archive (archiving operation). */
const ARCHIVE_EXTS = new Set([".zip", ".tar", ".gz", ".7z", ".archived"]);
/** Extensions produced by Advanced Encrypt (encrypting operation). */
const ENCRYPT_EXTS = new Set([".enc", ".encrypted", ".aenc"]);

function getFileExt(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > 0 ? path.substring(dot).toLowerCase() : "";
}

/** Return a plugin-specific icon name if this history entry represents an
 *  archive or encrypt operation (detected by extension change on rename). */
function getPluginOpIcon(entry: SyncHistoryEntry): string | null {
  if (!entry.oldPath) return null;
  const fromExt = getFileExt(entry.oldPath);
  const toExt   = getFileExt(entry.path);
  if (ARCHIVE_EXTS.has(toExt)  && !ARCHIVE_EXTS.has(fromExt))  return "archive";
  if (!ARCHIVE_EXTS.has(toExt) && ARCHIVE_EXTS.has(fromExt))   return "archive-restore";
  if (ENCRYPT_EXTS.has(toExt)  && !ENCRYPT_EXTS.has(fromExt))  return "lock";
  if (!ENCRYPT_EXTS.has(toExt) && ENCRYPT_EXTS.has(fromExt))   return "unlock";
  return null;
}

const STATE_LABELS: Record<string, string> = {
  disconnected:   "Disconnected",
  connecting:     "Connecting...",
  authenticating: "Authenticating...",
  syncing:        "Syncing...",
  idle:           "Connected",
  error:          "Error",
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
  /** Called when the user middle-clicks a file entry to open it in a new tab. */
  onNavigateNewTab?: (path: string) => void;
  /** Returns true if the plugin has a server configured. */
  isConfigured?: () => boolean;
}

export class SyncActivityRenderer {
  private container: HTMLElement;
  private options: SyncActivityRendererOptions;
  private badgeEl: HTMLElement | null = null;
  private historySection: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressBarFill: HTMLElement | null = null;
  private progressTextEl: HTMLElement | null = null;

  constructor(container: HTMLElement, options: SyncActivityRendererOptions) {
    this.container = container;
    this.options = options;
  }

  /** Full re-render (state badge + progress bar + unified history list). */
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

    // Unified list: in-progress items (grayed) followed by history
    this.historySection = this.container.createDiv("as-activity-history");
    this.renderHistory();
  }

  /** Incremental update: refresh the unified list (includes in-progress items). */
  refreshActive(): void {
    if (this.historySection) this.renderHistory();
    this.renderBadge();
  }

  /** Incremental update: refresh the unified list. */
  refreshHistory(): void {
    if (this.historySection) this.renderHistory();
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
    if (this.options.badgeContainer) this.options.badgeContainer.empty();
    this.badgeEl = null;
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
  }

  private renderHistory(): void {
    if (!this.historySection) return;
    this.historySection.empty();

    const inProgress = this.options.getActiveItems().filter(
      i => i.status === "active" || i.status === "pending"
    );
    const history = this.options.getHistory();
    const maxItems = this.options.maxHistoryItems ?? 50;

    if (inProgress.length === 0 && history.length === 0) {
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

    // In-progress items — same row shape as history, grayed out
    for (const item of inProgress) {
      const row = this.historySection.createDiv("as-history-view-row as-history-view-row-pending");

      const icon = row.createSpan("as-history-view-icon");
      icon.addClass(`as-dir-${item.direction}`);
      setIcon(icon, DIRECTION_ICON[item.direction] || "arrow-right");

      const info = row.createDiv("as-history-view-info");
      const nameRow = info.createDiv("as-history-view-name-row");

      const dotIdx = item.filename.lastIndexOf(".");
      const hasExt = dotIdx > 0;
      const displayName = hasExt ? item.filename.substring(0, dotIdx) : item.filename;
      const ext = hasExt ? item.filename.substring(dotIdx + 1) : "";
      nameRow.createSpan({ text: displayName, cls: "as-history-view-name" });
      if (hasExt && ext.toLowerCase() !== "md") {
        nameRow.createSpan({ text: ext.toUpperCase(), cls: "as-history-view-ext" });
      }

      if (isFileDirection(item.direction)) {
        info.createDiv({ text: item.path, cls: "as-history-view-path" });
      }

      if (item.status === "active") {
        const spinEl = row.createSpan("as-history-view-time as-history-view-time-pending as-history-view-spinner");
        setIcon(spinEl, "loader-2");
        spinEl.style.animationDelay = `-${Date.now() % 1000}ms`;
      } else {
        row.createSpan({ text: "waiting…", cls: "as-history-view-time as-history-view-time-pending" });
      }
    }

    // Completed history entries
    for (const entry of history.slice(0, maxItems)) {
      const rowClasses = ["as-history-view-row"];
      if (entry.pending) rowClasses.push("as-history-view-row-pending");
      const isNavigable = isFileDirection(entry.direction) && this.options.onNavigate
        && !entry.pending && entry.direction !== "delete"
        && !entry.path.startsWith(".obsidian/");
      if (isNavigable) rowClasses.push("as-history-view-row-clickable");
      const row = this.historySection.createDiv(rowClasses.join(" "));

      if (isNavigable) {
        const navigate = this.options.onNavigate!;
        row.addEventListener("click", () => navigate(entry.path));
        if (this.options.onNavigateNewTab) {
          const navigateNewTab = this.options.onNavigateNewTab;
          row.addEventListener("auxclick", (e) => {
            if (e.button === 1) { e.preventDefault(); navigateNewTab(entry.path); }
          });
        }
      }

      const icon = row.createSpan("as-history-view-icon");
      const pluginIcon = getPluginOpIcon(entry);
      icon.addClass(`as-dir-${entry.direction}`);
      setIcon(icon, pluginIcon ?? DIRECTION_ICON[entry.direction] ?? "arrow-right");

      const info = row.createDiv("as-history-view-info");
      const nameRow = info.createDiv("as-history-view-name-row");

      const dotIdx = entry.filename.lastIndexOf(".");
      const hasExt = dotIdx > 0;
      const displayName = hasExt ? entry.filename.substring(0, dotIdx) : entry.filename;
      const ext = hasExt ? entry.filename.substring(dotIdx + 1) : "";
      nameRow.createSpan({ text: displayName, cls: "as-history-view-name" });

      if (hasExt && ext.toLowerCase() !== "md") {
        nameRow.createSpan({ text: ext.toUpperCase(), cls: "as-history-view-ext" });
      }

      if (entry.count > 1) {
        const flashNow = (entry as any).flash === true;
        if (flashNow) (entry as any).flash = false;
        const countCls = flashNow
          ? "as-history-view-count as-history-view-count-flash"
          : "as-history-view-count";
        nameRow.createSpan({ text: `\u00d7${entry.count}`, cls: countCls });
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
