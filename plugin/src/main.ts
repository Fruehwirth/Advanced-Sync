/**
 * Advanced Sync — Obsidian Plugin Entry Point.
 * E2E encrypted vault sync across devices via a self-hosted Docker server.
 */

import { Plugin, Notice, setIcon } from "obsidian";
import type { SyncState } from "@vault-sync/shared/types";
import { SyncEngine } from "./sync/sync-engine";
import { SyncStatusBar } from "./ui/sync-status";
import { SyncPopup } from "./ui/sync-popup";
import { SyncHistoryView, SYNC_HISTORY_VIEW_TYPE } from "./ui/sync-history-view";
import { AdvancedSyncSettingsTab } from "./settings";
import { SetupWizardModal } from "./ui/wizard-modal";
import { LoadingOverlay } from "./ui/loading-overlay";
import type { AdvancedSyncSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

/** CSS variables to forward to the server web UI. */
const THEME_VARS = [
  "--background-primary",
  "--background-secondary",
  "--background-modifier-border",
  "--background-modifier-hover",
  "--text-normal",
  "--text-muted",
  "--text-faint",
  "--interactive-accent",
  "--color-green",
  "--color-red",
  "--font-interface",
  "--radius-s",
  "--radius-m",
  "--radius-l",
];

export default class AdvancedSyncPlugin extends Plugin {
  settings: AdvancedSyncSettings = { ...DEFAULT_SETTINGS };
  syncEngine!: SyncEngine;
  statusBar!: SyncStatusBar;
  private popup!: SyncPopup;
  private overlay: LoadingOverlay | null = null;
  /** Timer before the overlay is shown — cancelled if sync finishes < 500ms. */
  private overlayTimer: ReturnType<typeof setTimeout> | null = null;
  private encryptionPassword: string = "";
  private currentState: SyncState = "disconnected";
  private ribbonIconEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (!this.settings.clientId) {
      this.settings.clientId = this.generateClientId();
      await this.saveSettings();
    }

    this.syncEngine = new SyncEngine(this.app, this.settings, () => this.saveSettings());

    this.syncEngine.onStateChange = (state, detail) => {
      this.handleStateChange(state, detail);
    };

    this.syncEngine.onProgress = (current, total, detail) => {
      if (this.overlay) this.overlay.update(current, total, detail);
    };

    this.statusBar = new SyncStatusBar(this, () => this.openStatusPopup());

    this.popup = new SyncPopup(this.statusBar.el, {
      onToggleSync:  (enabled) => this.handleToggleSync(enabled),
      onForceSync:   () => this.forceSync(),
      onDisconnect:  () => this.disconnectFromServer(),
      onConnect:     () => this.promptAndConnect(),
    });

    this.addSettingTab(new AdvancedSyncSettingsTab(this.app, this));

    // Register sidebar view
    this.registerView(SYNC_HISTORY_VIEW_TYPE, (leaf) =>
      new SyncHistoryView(
        leaf,
        () => this.syncEngine?.history ?? [],
        () => this.currentState,
      )
    );

    // Ribbon icon — visible on mobile as status indicator
    this.ribbonIconEl = this.addRibbonIcon("refresh-cw", "Advanced Sync", () => {
      this.activateHistoryView();
    });
    this.updateRibbonIcon(this.currentState);

    this.addCommand({ id: "connect",     name: "Connect to sync server",  callback: () => this.connectToServer() });
    this.addCommand({ id: "disconnect",  name: "Disconnect from sync server", callback: () => this.disconnectFromServer() });
    this.addCommand({ id: "force-sync",  name: "Force full sync",          callback: () => this.forceSync() });
    this.addCommand({ id: "setup-wizard", name: "Run setup wizard",        callback: () => this.runSetupWizard() });
    this.addCommand({ id: "show-history", name: "Show sync history",      callback: () => this.activateHistoryView() });

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.setupComplete && this.settings.autoConnect && this.settings.syncEnabled) {
        this.promptAndConnect();
      }
    });
  }

  onunload(): void {
    this.popup?.close();
    this.syncEngine?.disconnect();
    this.statusBar?.destroy();
    this.overlay?.dismiss();
    if (this.overlayTimer) clearTimeout(this.overlayTimer);
    this.encryptionPassword = "";
    this.app.workspace.detachLeavesOfType(SYNC_HISTORY_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Open the settings tab to the wizard (inline). */
  async runSetupWizard(): Promise<void> {
    (this.app as any).setting?.open();
    (this.app as any).setting?.openTabById("advanced-sync");
  }

  /** Called by the inline wizard after collecting all credentials. */
  async connectWithEncryptionPassword(password: string): Promise<void> {
    this.encryptionPassword = password;
    await this.connectWithPassword(password);
  }

  private openStatusPopup(): void {
    this.popup.open(this.settings.syncEnabled, this.currentState, this.syncEngine.history);
  }

  private async handleToggleSync(enabled: boolean): Promise<void> {
    this.settings.syncEnabled = enabled;
    await this.saveSettings();
    if (enabled) await this.promptAndConnect();
    else this.disconnectFromServer();
  }

  private async promptAndConnect(): Promise<void> {
    if (!this.settings.setupComplete) {
      await this.runSetupWizard();
      return;
    }
    if (!this.encryptionPassword) {
      const { PasswordPromptModal } = await import("./ui/wizard-modal");
      const pw = await PasswordPromptModal.prompt(this.app);
      if (!pw) return;
      this.encryptionPassword = pw;
    }
    await this.connectWithPassword(this.encryptionPassword);
  }

  private async connectToServer(): Promise<void> { await this.promptAndConnect(); }

  private disconnectFromServer(): void {
    if (this.overlayTimer) { clearTimeout(this.overlayTimer); this.overlayTimer = null; }
    this.overlay?.dismiss(); this.overlay = null;
    this.syncEngine.disconnect();
    new Notice("Advanced Sync: Disconnected");
  }

  private async forceSync(): Promise<void> {
    if (this.syncEngine.state === "idle") {
      this.showOverlayDelayed("Starting full sync...");
      await this.syncEngine.forceSync();
    } else {
      new Notice("Advanced Sync: Not connected or already syncing");
    }
  }

  private async connectWithPassword(password: string): Promise<void> {
    this.showOverlayDelayed("Connecting to server...");
    await this.syncEngine.connect(password);
  }

  /** Show the overlay only if the operation takes longer than 500ms. */
  private showOverlayDelayed(message: string): void {
    if (this.overlayTimer) clearTimeout(this.overlayTimer);
    this.overlayTimer = setTimeout(() => {
      this.overlayTimer = null;
      if (this.currentState !== "idle" && this.currentState !== "disconnected") {
        this.overlay = new LoadingOverlay();
        this.overlay.show(message);
      }
    }, 500);
  }

  private handleStateChange(state: SyncState, detail?: string): void {
    this.currentState = state;
    this.statusBar.update(state, detail);
    this.updateRibbonIcon(state);
    this.refreshHistoryViews();

    // Cancel overlay timer if we finish before 500ms
    if (state === "idle" || state === "error" || state === "disconnected") {
      if (this.overlayTimer) {
        clearTimeout(this.overlayTimer);
        this.overlayTimer = null;
      }
    }

    switch (state) {
      case "idle":
        this.overlay?.dismiss(); this.overlay = null;
        this.syncEngine.checkPluginChanges();
        // Send current theme to server so web UI matches Obsidian
        this.sendThemeToServer();
        break;
      case "error":
        this.overlay?.dismiss(); this.overlay = null;
        if (detail) new Notice(`Advanced Sync: ${detail}`, 5000);
        break;
      case "syncing":
        if (this.overlay) this.overlay.show("Syncing...");
        break;
    }
  }

  /** Extract Obsidian's current CSS variables and POST them to the server. */
  private sendThemeToServer(): void {
    if (!this.settings.serverUrl) return;
    const httpUrl = this.settings.serverUrl
      .replace("wss://", "https://")
      .replace("ws://", "http://")
      .replace(/\/sync$/, "");

    try {
      const style = getComputedStyle(document.body);
      const theme: Record<string, string> = {};
      for (const v of THEME_VARS) {
        const val = style.getPropertyValue(v).trim();
        if (val) theme[v] = val;
      }
      fetch(`${httpUrl}/api/theme`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(theme),
      }).catch(() => {});
    } catch {}
  }

  /** Update the ribbon icon to reflect current sync state. */
  private updateRibbonIcon(state: SyncState): void {
    if (!this.ribbonIconEl) return;

    // Remove all state classes
    this.ribbonIconEl.removeClass(
      "as-ribbon-disconnected", "as-ribbon-connecting",
      "as-ribbon-syncing", "as-ribbon-idle", "as-ribbon-error"
    );

    const RIBBON_MAP: Record<SyncState, { cls: string; icon: string; tooltip: string }> = {
      disconnected:   { cls: "as-ribbon-disconnected",  icon: "wifi-off",       tooltip: "Sync: Disconnected" },
      connecting:     { cls: "as-ribbon-connecting",     icon: "loader",         tooltip: "Sync: Connecting..." },
      authenticating: { cls: "as-ribbon-connecting",     icon: "loader",         tooltip: "Sync: Authenticating..." },
      syncing:        { cls: "as-ribbon-syncing",        icon: "refresh-cw",     tooltip: "Sync: Syncing..." },
      idle:           { cls: "as-ribbon-idle",           icon: "check-circle",   tooltip: "Sync: Connected" },
      error:          { cls: "as-ribbon-error",          icon: "alert-triangle", tooltip: "Sync: Error" },
    };

    const config = RIBBON_MAP[state] || RIBBON_MAP.disconnected;
    this.ribbonIconEl.addClass(config.cls);
    this.ribbonIconEl.ariaLabel = config.tooltip;

    // Update the icon inside
    this.ribbonIconEl.empty();
    setIcon(this.ribbonIconEl, config.icon);
  }

  /** Open (or focus) the sync history sidebar tab. */
  private async activateHistoryView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNC_HISTORY_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SYNC_HISTORY_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  /** Refresh all open sync history views. */
  private refreshHistoryViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SYNC_HISTORY_VIEW_TYPE)) {
      const view = leaf.view as SyncHistoryView;
      view.refresh();
    }
  }

  private generateClientId(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  }
}
