/**
 * Status bar indicator for sync state.
 * Shows in the Obsidian status bar (bottom right, next to word count).
 * Uses Lucide icons via setIcon().
 */

import { setIcon } from "obsidian";
import type { Plugin } from "obsidian";
import type { SyncState } from "@vault-sync/shared/types";

interface StatusConfig {
  icon: string;
  text: string;
  cls: string;
}

const STATUS_MAP: Record<SyncState, StatusConfig> = {
  disconnected:   { icon: "wifi-off",       text: "Sync: Off",      cls: "as-status-off" },
  connecting:     { icon: "loader",         text: "Connecting...",  cls: "as-status-connecting" },
  authenticating: { icon: "loader",         text: "Authenticating...", cls: "as-status-connecting" },
  syncing:        { icon: "refresh-cw",     text: "Syncing...",     cls: "as-status-syncing" },
  idle:           { icon: "check-circle",   text: "Synced",         cls: "as-status-synced" },
  error:          { icon: "alert-triangle", text: "Sync Error",     cls: "as-status-error" },
};

export class SyncStatusBar {
  /** The DOM element — exposed so the popup can anchor to it. */
  readonly el: HTMLElement;
  private iconEl: HTMLElement;
  private textEl: HTMLElement;

  constructor(plugin: Plugin, onClick: () => void) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass("as-statusbar");
    this.el.addEventListener("click", onClick);
    this.el.setAttribute("aria-label", "Advanced Sync — click to view sync status");

    this.iconEl = this.el.createSpan("as-statusbar-icon");
    this.textEl = this.el.createSpan("as-statusbar-text");

    this.update("disconnected");
  }

  update(state: SyncState, detail?: string): void {
    const config = STATUS_MAP[state] || STATUS_MAP.disconnected;

    this.iconEl.empty();
    setIcon(this.iconEl, config.icon);

    let text = config.text;
    if (state === "syncing" && detail) text = detail;
    else if (state === "error" && detail) text = `Error: ${detail}`;
    this.textEl.textContent = text;

    this.el.className = "as-statusbar";
    this.el.addClass(config.cls);
  }

  destroy(): void {
    this.el.remove();
  }
}
