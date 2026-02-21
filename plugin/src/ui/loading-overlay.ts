/**
 * Fullscreen loading overlay shown during initial sync and reconnect.
 * Displays progress information and allows dismissal.
 */

import { setIcon } from "obsidian";

export class LoadingOverlay {
  private el: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private barFill: HTMLElement | null = null;

  /** Show the overlay with an initial message. */
  show(message: string): void {
    if (this.el) {
      this.updateMessage(message);
      return;
    }

    this.el = document.createElement("div");
    this.el.className = "as-overlay";

    const content = document.createElement("div");
    content.className = "as-overlay-content";

    // Icon
    const iconEl = document.createElement("div");
    iconEl.className = "as-overlay-icon";
    setIcon(iconEl, "refresh-cw");
    content.appendChild(iconEl);

    // Title
    const titleEl = document.createElement("div");
    titleEl.className = "as-overlay-title";
    titleEl.textContent = "Advanced Sync";
    content.appendChild(titleEl);

    // Progress text
    this.progressEl = document.createElement("div");
    this.progressEl.className = "as-overlay-progress";
    this.progressEl.textContent = message;
    content.appendChild(this.progressEl);

    // Progress bar
    const barContainer = document.createElement("div");
    barContainer.className = "as-overlay-bar";
    this.barFill = document.createElement("div");
    this.barFill.className = "as-overlay-bar-fill";
    barContainer.appendChild(this.barFill);
    content.appendChild(barContainer);

    // Detail text
    this.detailEl = document.createElement("div");
    this.detailEl.className = "as-overlay-detail";
    content.appendChild(this.detailEl);

    // Dismiss hint
    const hint = document.createElement("div");
    hint.className = "as-overlay-hint";
    hint.textContent = "Press Escape to continue without waiting";
    content.appendChild(hint);

    this.el.appendChild(content);
    document.body.appendChild(this.el);

    // Escape to dismiss
    this.el.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") this.dismiss();
    });
    this.el.addEventListener("click", (e: MouseEvent) => {
      if (e.target === this.el) this.dismiss();
    });
    this.el.setAttribute("tabindex", "0");
    this.el.focus();
  }

  /** Update progress. */
  update(current: number, total: number, detail: string): void {
    if (!this.el) return;

    const pct = total > 0 ? Math.round((current / total) * 100) : 0;

    if (this.progressEl) {
      this.progressEl.textContent = `${pct}% (${current}/${total})`;
    }
    if (this.detailEl) {
      this.detailEl.textContent = detail;
    }
    if (this.barFill) {
      this.barFill.style.width = `${pct}%`;
    }
  }

  private updateMessage(message: string): void {
    if (this.progressEl) {
      this.progressEl.textContent = message;
    }
  }

  /** Remove the overlay. */
  dismiss(): void {
    if (this.el) {
      this.el.remove();
      this.el = null;
      this.progressEl = null;
      this.detailEl = null;
      this.barFill = null;
    }
  }
}
