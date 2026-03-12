/**
 * Sync History sidebar view — pinnable tab showing recent sync changes.
 * Uses the unified SyncActivityRenderer for consistent display.
 */

import { ItemView, WorkspaceLeaf, Platform, setIcon } from "obsidian";
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
  private onNavigateNewTab?: (path: string) => void;
  private getHideObsidian: () => boolean;
  private setHideObsidian: (value: boolean) => void;
  private onReconnect?: () => void;
  private renderer: SyncActivityRenderer | null = null;
  private eyeBtn: HTMLElement | null = null;

  // Pull-to-refresh state
  private pullSpinner: HTMLElement | null = null;
  private scrollContainer: HTMLElement | null = null;
  private pullActive = false;
  private pullTriggered = false;
  private startY = 0;
  private currentPull = 0;
  private readonly PULL_THRESHOLD = 60;

  constructor(
    leaf: WorkspaceLeaf,
    getHistory: () => SyncHistoryEntry[],
    getState: () => SyncState,
    getActiveItems: () => SyncActivityItem[],
    onNavigate?: (path: string) => void,
    isConfigured?: () => boolean,
    onNavigateNewTab?: (path: string) => void,
    getHideObsidian?: () => boolean,
    setHideObsidian?: (value: boolean) => void,
    onReconnect?: () => void,
  ) {
    super(leaf);
    this.getHistory = getHistory;
    this.getState = getState;
    this.getActiveItems = getActiveItems;
    this.onNavigate = onNavigate;
    this.isConfigured = isConfigured;
    this.onNavigateNewTab = onNavigateNewTab;
    this.getHideObsidian = getHideObsidian ?? (() => false);
    this.setHideObsidian = setHideObsidian ?? (() => {});
    this.onReconnect = onReconnect;
  }

  getViewType(): string { return SYNC_HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return "Sync History"; }
  getIcon(): string { return "refresh-cw"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("as-history-view");

    // Header — title on the left, eye toggle + status badge on the right
    const header = container.createDiv("as-history-view-header");
    header.createSpan({ text: "Recent Changes", cls: "as-history-view-title" });

    const headerRight = header.createDiv("as-history-view-header-right");

    // Eye toggle button
    this.eyeBtn = headerRight.createDiv("as-history-view-eye-btn");
    this.eyeBtn.addEventListener("click", () => {
      const newVal = !this.getHideObsidian();
      this.setHideObsidian(newVal);
      this.updateEyeIcon();
      this.renderer?.render();
    });
    this.updateEyeIcon();

    const badgeSlot = headerRight.createDiv();

    // Scrollable content wrapper (for pull-to-refresh)
    this.scrollContainer = container.createDiv("as-history-view-scroll");

    // Pull-to-refresh spinner (mobile only)
    if (Platform.isMobile) {
      this.pullSpinner = this.scrollContainer.createDiv("as-pull-spinner");
      const spinnerIcon = this.pullSpinner.createDiv("as-pull-spinner-icon");
      setIcon(spinnerIcon, "loader-2");
      this.setupPullToRefresh();
    }

    // Renderer container
    const rendererContainer = this.scrollContainer.createDiv("as-history-view-content");

    this.renderer = new SyncActivityRenderer(rendererContainer, {
      getActiveItems: this.getActiveItems,
      getHistory: this.getHistory,
      getState: this.getState,
      badgeContainer: badgeSlot,
      onNavigate: this.onNavigate,
      isConfigured: this.isConfigured,
      onNavigateNewTab: this.onNavigateNewTab,
    });
    this.renderer.render();
  }

  private setupPullToRefresh(): void {
    const el = this.scrollContainer!;

    el.addEventListener("touchstart", (e) => {
      if (this.pullTriggered) return;
      if (el.scrollTop <= 0) {
        this.pullActive = true;
        this.startY = e.touches[0].clientY;
        this.currentPull = 0;
      }
    }, { passive: true });

    el.addEventListener("touchmove", (e) => {
      if (!this.pullActive || this.pullTriggered) return;
      const dy = e.touches[0].clientY - this.startY;
      if (dy < 0) { this.currentPull = 0; this.updatePullUI(0); return; }
      // Dampen the pull (diminishing returns)
      this.currentPull = Math.min(dy * 0.5, this.PULL_THRESHOLD * 1.8);
      this.updatePullUI(this.currentPull);
    }, { passive: true });

    el.addEventListener("touchend", () => {
      if (!this.pullActive || this.pullTriggered) return;
      this.pullActive = false;
      if (this.currentPull >= this.PULL_THRESHOLD) {
        this.triggerRefresh();
      } else {
        this.updatePullUI(0);
      }
    });
  }

  private updatePullUI(pull: number): void {
    if (!this.pullSpinner) return;
    const height = Math.round(pull);
    this.pullSpinner.style.height = `${height}px`;
    this.pullSpinner.style.opacity = `${Math.min(pull / this.PULL_THRESHOLD, 1)}`;
    // Rotate the icon proportionally to the pull
    const icon = this.pullSpinner.querySelector(".as-pull-spinner-icon") as HTMLElement | null;
    if (icon) {
      const rotation = (pull / this.PULL_THRESHOLD) * 360;
      icon.style.transform = `rotate(${rotation}deg)`;
    }
  }

  private triggerRefresh(): void {
    if (!this.pullSpinner) return;
    this.pullTriggered = true;

    // Lock spinner at threshold height with spinning animation
    this.pullSpinner.style.height = `${this.PULL_THRESHOLD}px`;
    this.pullSpinner.style.opacity = "1";
    this.pullSpinner.addClass("as-pull-spinner-active");
    const icon = this.pullSpinner.querySelector(".as-pull-spinner-icon") as HTMLElement | null;
    if (icon) icon.style.transform = "";

    // Attempt reconnect
    this.onReconnect?.();
  }

  /** Called externally when connection state changes — hides spinner on connect or failure. */
  notifyStateChange(state: SyncState): void {
    if (!this.pullTriggered) return;
    if (state === "idle" || state === "syncing") {
      this.hideSpinner();
    } else if (state === "error") {
      // Connection attempt failed — hide after a brief pause so user sees the state change
      setTimeout(() => this.hideSpinner(), 500);
    }
  }

  private hideSpinner(): void {
    if (!this.pullSpinner) return;
    this.pullTriggered = false;
    this.pullSpinner.removeClass("as-pull-spinner-active");
    this.pullSpinner.style.transition = "height 0.3s ease-out, opacity 0.3s ease-out";
    this.pullSpinner.style.height = "0px";
    this.pullSpinner.style.opacity = "0";
    setTimeout(() => {
      if (this.pullSpinner) this.pullSpinner.style.transition = "";
    }, 300);
  }

  private updateEyeIcon(): void {
    if (!this.eyeBtn) return;
    this.eyeBtn.empty();
    const hidden = this.getHideObsidian();
    setIcon(this.eyeBtn, hidden ? "eye-off" : "eye");
    this.eyeBtn.setAttribute("aria-label", hidden ? "Show .obsidian/ files" : "Hide .obsidian/ files");
  }

  async onClose(): Promise<void> {
    this.renderer?.destroy();
    this.renderer = null;
    this.eyeBtn = null;
    this.pullSpinner = null;
    this.scrollContainer = null;
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
