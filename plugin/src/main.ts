/**
 * Advanced Sync — Obsidian Plugin Entry Point.
 * E2E encrypted vault sync across devices via a self-hosted Docker server.
 */

import { Plugin, Notice } from "obsidian";
import type { SyncState } from "@vault-sync/shared/types";
import { SyncEngine } from "./sync/sync-engine";
import { SyncStatusBar } from "./ui/sync-status";
import { SyncPopup } from "./ui/sync-popup";
import { SyncHistoryView, SYNC_HISTORY_VIEW_TYPE } from "./ui/sync-history-view";
import { AdvancedSyncSettingsTab } from "./settings";
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
  private settingsTab!: AdvancedSyncSettingsTab;
  private encryptionPassword: string = "";
  private currentState: SyncState = "disconnected";

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

    this.syncEngine.onHistoryChange = () => {
      this.popup.refreshIfOpen();
      this.refreshHistoryViews();
      this.settingsTab.notifyDataChanged?.();
    };

    // Wire progress into sidebar views and settings dashboard
    this.syncEngine.onProgress = (current, total, detail) => {
      for (const leaf of this.app.workspace.getLeavesOfType(SYNC_HISTORY_VIEW_TYPE)) {
        if (leaf.view instanceof SyncHistoryView) leaf.view.setProgress(current, total, detail);
      }
      this.settingsTab.notifyProgressChanged?.(current, total, detail);
    };

    this.statusBar = new SyncStatusBar(this, () => this.openStatusPopup());

    this.popup = new SyncPopup(
      this.statusBar.el,
      {
        onToggleSync:  (enabled) => this.handleToggleSync(enabled),
        onForceSync:   () => this.forceSync(),
        onDisconnect:  () => this.disconnectFromServer(),
        onConnect:     () => this.promptAndConnect(),
      },
      () => this.currentState,
      () => this.settings.syncEnabled,
    );

    this.settingsTab = new AdvancedSyncSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Register sidebar view
    this.registerView(SYNC_HISTORY_VIEW_TYPE, (leaf) =>
      new SyncHistoryView(
        leaf,
        () => {
          const h = this.syncEngine?.history ?? [];
          return this.settings.hideObsidianInHistory
            ? h.filter(e => !e.path.startsWith(".obsidian/"))
            : h;
        },
        () => this.currentState,
      )
    );

    this.addCommand({ id: "connect",      name: "Connect to sync server",     callback: () => this.connectToServer() });
    this.addCommand({ id: "disconnect",   name: "Disconnect from sync server", callback: () => this.disconnectFromServer() });
    this.addCommand({ id: "force-sync",   name: "Force full sync",             callback: () => this.forceSync() });
    this.addCommand({ id: "setup-wizard", name: "Run setup wizard",            callback: () => this.runSetupWizard() });
    this.addCommand({ id: "show-history", name: "Show sync history",           callback: () => this.activateHistoryView() });

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

  async runSetupWizard(): Promise<void> {
    (this.app as any).setting?.open();
    (this.app as any).setting?.openTabById("advanced-sync");
  }

  async connectWithEncryptionPassword(password: string): Promise<void> {
    this.encryptionPassword = password;
    await this.syncEngine.connect(password);
  }

  private openStatusPopup(): void {
    this.popup.open();
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
    await this.syncEngine.connect(this.encryptionPassword);
  }

  private async connectToServer(): Promise<void> { await this.promptAndConnect(); }

  private disconnectFromServer(): void {
    this.syncEngine.disconnect();
    new Notice("Advanced Sync: Disconnected");
  }

  private async forceSync(): Promise<void> {
    if (this.syncEngine.state === "idle") {
      await this.syncEngine.forceSync();
    } else {
      new Notice("Advanced Sync: Not connected or already syncing");
    }
  }

  private handleStateChange(state: SyncState, detail?: string): void {
    this.currentState = state;
    this.statusBar.update(state, detail);
    this.popup.refreshIfOpen();
    this.refreshHistoryViews();
    this.settingsTab.notifyDataChanged?.();

    switch (state) {
      case "idle":
        for (const leaf of this.app.workspace.getLeavesOfType(SYNC_HISTORY_VIEW_TYPE)) {
          if (leaf.view instanceof SyncHistoryView) leaf.view.clearProgress();
        }
        this.settingsTab.notifyProgressChanged?.(0, 0, "");
        this.syncEngine.checkPluginChanges();
        this.sendThemeToServer();
        break;
      case "error":
        for (const leaf of this.app.workspace.getLeavesOfType(SYNC_HISTORY_VIEW_TYPE)) {
          if (leaf.view instanceof SyncHistoryView) leaf.view.clearProgress();
        }
        this.settingsTab.notifyProgressChanged?.(0, 0, "");
        if (detail) new Notice(`Advanced Sync: ${detail}`, 5000);
        break;
    }
  }

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

  private refreshHistoryViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SYNC_HISTORY_VIEW_TYPE)) {
      if (leaf.view instanceof SyncHistoryView) leaf.view.refresh();
    }
  }

  private generateClientId(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  }
}
