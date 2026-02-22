/**
 * Quick-action popup anchored above the status bar item.
 * Shows sync state + toggle + action buttons in a vanilla Obsidian menu style.
 * No history list — that lives in the dedicated sidebar tab.
 */

import { setIcon } from "obsidian";
import type { SyncState } from "@vault-sync/shared/types";

export interface SyncPopupCallbacks {
  onToggleSync: (enabled: boolean) => void;
  onForceSync: () => void;
  onDisconnect: () => void;
  onConnect: () => void;
}

export class SyncPopup {
  private el: HTMLElement | null = null;
  private anchor: HTMLElement;
  private callbacks: SyncPopupCallbacks;
  private getState: () => SyncState;
  private getSyncEnabled: () => boolean;
  private boundClose: (e: MouseEvent) => void;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private statusBadgeEl: HTMLElement | null = null;

  constructor(
    anchor: HTMLElement,
    callbacks: SyncPopupCallbacks,
    getState: () => SyncState,
    getSyncEnabled: () => boolean,
  ) {
    this.anchor = anchor;
    this.callbacks = callbacks;
    this.getState = getState;
    this.getSyncEnabled = getSyncEnabled;
    this.boundClose = (e: MouseEvent) => {
      if (this.el && !this.el.contains(e.target as Node) && e.target !== this.anchor) {
        this.close();
      }
    };
  }

  get isOpen(): boolean { return this.el !== null; }

  /** Refresh the status badge if popup is open — called on state changes. */
  refreshIfOpen(): void {
    if (!this.el) return;
    this.renderStatusBadge();
  }

  open(): void {
    if (this.el) { this.close(); return; }

    const syncEnabled = this.getSyncEnabled();
    const state = this.getState();

    this.el = document.createElement("div");
    this.el.className = "as-popup";
    this.el.setAttribute("role", "menu");

    // ── Title row: icon + "Advanced Sync" + live status badge ──
    const titleRow = this.el.createDiv("as-popup-title-row");
    const titleIcon = titleRow.createSpan("as-popup-title-icon");
    setIcon(titleIcon, "refresh-cw");
    titleRow.createSpan({ text: "Advanced Sync", cls: "as-popup-title" });
    this.statusBadgeEl = titleRow.createDiv("as-popup-status-badge");

    this.el.createDiv("as-popup-separator");

    // ── Syncing toggle ──
    const toggleItem = this.el.createDiv("as-popup-menu-item as-popup-toggle-item");
    toggleItem.createSpan({ text: "Syncing", cls: "as-popup-menu-label" });
    const toggleLabel = toggleItem.createEl("label", { cls: "as-toggle-switch" });
    const checkbox = toggleLabel.createEl("input", { type: "checkbox" });
    checkbox.checked = syncEnabled;
    toggleLabel.createSpan({ cls: "as-toggle-track" });
    checkbox.addEventListener("change", () => this.callbacks.onToggleSync(checkbox.checked));

    this.el.createDiv("as-popup-separator");

    // ── Action items ──
    this.addMenuItem("refresh-cw", "Force sync", () => { this.close(); this.callbacks.onForceSync(); });

    if (state === "disconnected" || state === "error") {
      this.addMenuItem("wifi", "Connect", () => { this.close(); this.callbacks.onConnect(); });
    } else {
      this.addMenuItem("wifi-off", "Disconnect", () => { this.close(); this.callbacks.onDisconnect(); }, true);
    }

    // Render live status badge
    this.renderStatusBadge();

    document.body.appendChild(this.el);
    this.position();

    // Refresh status badge every 2s while open
    this.refreshInterval = setInterval(() => this.renderStatusBadge(), 2000);

    setTimeout(() => {
      document.addEventListener("click", this.boundClose, true);
    }, 0);
  }

  close(): void {
    document.removeEventListener("click", this.boundClose, true);
    if (this.refreshInterval) { clearInterval(this.refreshInterval); this.refreshInterval = null; }
    if (this.el) { this.el.remove(); this.el = null; }
    this.statusBadgeEl = null;
  }

  private addMenuItem(icon: string, label: string, onClick: () => void, danger = false): void {
    const item = this.el!.createDiv("as-popup-menu-item");
    if (danger) item.addClass("as-popup-menu-item-danger");
    const iconEl = item.createSpan("as-popup-menu-icon");
    setIcon(iconEl, icon);
    item.createSpan({ text: label, cls: "as-popup-menu-label" });
    item.addEventListener("click", onClick);
  }

  private renderStatusBadge(): void {
    if (!this.statusBadgeEl) return;
    const state = this.getState();
    this.statusBadgeEl.empty();
    this.statusBadgeEl.className = `as-popup-status-badge as-popup-status-${state}`;
    this.statusBadgeEl.createSpan("as-popup-status-dot");
    this.statusBadgeEl.createSpan({ text: this.stateLabel(state) });
  }

  private position(): void {
    if (!this.el) return;
    const rect = this.anchor.getBoundingClientRect();
    let right = window.innerWidth - rect.right;
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
}
