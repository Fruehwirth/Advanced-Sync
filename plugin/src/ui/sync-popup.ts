/**
 * Status bar popup — shows sync history and a sync enable/disable toggle.
 * Appears as a floating panel anchored above the status bar item.
 */

import { setIcon } from "obsidian";
import type { SyncHistoryEntry } from "../sync/sync-engine";
import type { SyncState } from "@vault-sync/shared/types";

export interface SyncPopupCallbacks {
  onToggleSync: (enabled: boolean) => void;
  onForceSync: () => void;
  onDisconnect: () => void;
  onConnect: () => void;
}

const DIRECTION_ICON: Record<SyncHistoryEntry["direction"], string> = {
  upload:     "arrow-up",
  download:   "arrow-down",
  delete:     "trash-2",
  connect:    "wifi",
  disconnect: "wifi-off",
  error:      "alert-triangle",
};

export class SyncPopup {
  private el: HTMLElement | null = null;
  private anchor: HTMLElement;
  private callbacks: SyncPopupCallbacks;
  private boundClose: (e: MouseEvent) => void;

  constructor(anchor: HTMLElement, callbacks: SyncPopupCallbacks) {
    this.anchor = anchor;
    this.callbacks = callbacks;
    this.boundClose = (e: MouseEvent) => {
      if (this.el && !this.el.contains(e.target as Node) && e.target !== this.anchor) {
        this.close();
      }
    };
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(
    syncEnabled: boolean,
    state: SyncState,
    history: SyncHistoryEntry[]
  ): void {
    if (this.el) {
      this.close();
      return; // toggle
    }

    this.el = document.createElement("div");
    this.el.className = "as-popup";
    this.el.setAttribute("role", "dialog");

    // ---- Header ----
    const header = this.el.createDiv("as-popup-header");

    const titleRow = header.createDiv("as-popup-title-row");
    const titleIcon = titleRow.createSpan("as-popup-title-icon");
    setIcon(titleIcon, "refresh-cw");
    titleRow.createSpan({ text: "Advanced Sync", cls: "as-popup-title" });

    // Sync toggle
    const toggleRow = header.createDiv("as-popup-toggle-row");
    toggleRow.createSpan({ text: "Syncing", cls: "as-popup-toggle-label" });

    const toggleLabel = toggleRow.createEl("label", { cls: "as-toggle-switch" });
    const checkbox = toggleLabel.createEl("input", { type: "checkbox" });
    checkbox.checked = syncEnabled;
    toggleLabel.createSpan({ cls: "as-toggle-track" });

    checkbox.addEventListener("change", () => {
      this.callbacks.onToggleSync(checkbox.checked);
    });

    // Connection status badge
    const statusBadge = header.createDiv("as-popup-status-badge");
    statusBadge.addClass(`as-popup-status-${state}`);
    const badgeDot = statusBadge.createSpan("as-popup-status-dot");
    statusBadge.createSpan({ text: this.stateLabel(state) });

    // ---- History ----
    const section = this.el.createDiv("as-popup-section");
    section.createDiv({ text: "Recent Changes", cls: "as-popup-section-title" });

    const list = section.createDiv("as-popup-history");

    if (history.length === 0) {
      list.createDiv({ text: "No changes yet", cls: "as-popup-empty" });
    } else {
      for (const entry of history.slice(0, 20)) {
        const row = list.createDiv("as-popup-history-row");

        const icon = row.createSpan("as-popup-history-icon");
        icon.addClass(`as-dir-${entry.direction}`);
        setIcon(icon, DIRECTION_ICON[entry.direction]);

        const info = row.createDiv("as-popup-history-info");

        const nameRow = info.createDiv("as-popup-history-name-row");
        nameRow.createSpan({ text: entry.filename, cls: "as-popup-history-name" });
        if (entry.count > 1) {
          nameRow.createSpan({ text: `×${entry.count}`, cls: "as-popup-history-count" });
        }

        info.createDiv({ text: entry.path, cls: "as-popup-history-path" });

        row.createSpan({ text: this.formatTime(entry.timestamp), cls: "as-popup-history-time" });
      }
    }

    // ---- Footer actions ----
    const footer = this.el.createDiv("as-popup-footer");

    const forceSyncBtn = footer.createEl("button", { cls: "as-popup-btn" });
    setIcon(forceSyncBtn.createSpan(), "refresh-cw");
    forceSyncBtn.createSpan({ text: "Force sync" });
    forceSyncBtn.addEventListener("click", () => {
      this.close();
      this.callbacks.onForceSync();
    });

    if (state === "disconnected" || state === "error") {
      const connectBtn = footer.createEl("button", { cls: "as-popup-btn" });
      setIcon(connectBtn.createSpan(), "wifi");
      connectBtn.createSpan({ text: "Connect" });
      connectBtn.addEventListener("click", () => {
        this.close();
        this.callbacks.onConnect();
      });
    } else {
      const disconnectBtn = footer.createEl("button", { cls: "as-popup-btn as-popup-btn-danger" });
      setIcon(disconnectBtn.createSpan(), "wifi-off");
      disconnectBtn.createSpan({ text: "Disconnect" });
      disconnectBtn.addEventListener("click", () => {
        this.close();
        this.callbacks.onDisconnect();
      });
    }

    // Position above the anchor element
    document.body.appendChild(this.el);
    this.position();

    // Close on outside click (deferred so this click doesn't immediately close it)
    setTimeout(() => {
      document.addEventListener("click", this.boundClose, true);
    }, 0);
  }

  close(): void {
    document.removeEventListener("click", this.boundClose, true);
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }

  private position(): void {
    if (!this.el) return;
    const rect = this.anchor.getBoundingClientRect();
    const popupHeight = this.el.offsetHeight || 360;
    const popupWidth = this.el.offsetWidth || 300;

    // Align right edge to anchor right, place above anchor
    let top = rect.top - popupHeight - 8;
    let right = window.innerWidth - rect.right;

    // If it would go above the viewport, flip to below
    if (top < 8) top = rect.bottom + 8;
    // If it would go off the right edge, clamp
    if (right < 8) right = 8;

    this.el.style.position = "fixed";
    this.el.style.bottom = (window.innerHeight - rect.top + 8) + "px";
    this.el.style.right = right + "px";
    this.el.style.top = "auto";
  }

  private stateLabel(state: SyncState): string {
    const labels: Record<SyncState, string> = {
      disconnected:   "Disconnected",
      connecting:     "Connecting...",
      authenticating: "Authenticating...",
      syncing:        "Syncing...",
      idle:           "Connected",
      error:          "Error",
    };
    return labels[state] ?? state;
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - ts;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1)  return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;

    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;

    // Different day: show date
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}
