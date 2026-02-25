/**
 * Settings tab for Advanced Sync.
 * Includes the full inline setup wizard (single password, sync preview) and the dashboard.
 */

import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { sha256String } from "./crypto/encryption";
import { discoverServers, isDiscoveryAvailable } from "./network/discovery";
import type { InitialSyncStrategy } from "./types";
import type { ClientSession } from "@vault-sync/shared/types";
import type AdvancedSyncPlugin from "./main";
import { SyncActivityRenderer } from "./ui/sync-activity";

const TOTAL_STEPS = 8;

function toHttpUrl(wsUrl: string): string {
  return wsUrl.replace("wss://", "https://").replace("ws://", "http://").replace(/\/sync$/, "");
}

function getHostname(): string {
  try { return require("os").hostname(); } catch { return "My Device"; }
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts, m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function stateLabel(state: string): string {
  const map: Record<string, string> = {
    disconnected: "Disconnected", connecting: "Connecting...",
    authenticating: "Authenticating...", syncing: "Syncing...",
    idle: "Connected", error: "Error",
  };
  return map[state] ?? state;
}

function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

/** Scroll an input into view after keyboard appears (mobile). */
function focusAndScroll(input: HTMLElement): void {
  setTimeout(() => input.focus(), 50);
  input.addEventListener("focus", () => {
    setTimeout(() => input.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  }, { once: true });
}


export class AdvancedSyncSettingsTab extends PluginSettingTab {
  plugin: AdvancedSyncPlugin;

  /** Called by main.ts when history or state changes — re-renders live dashboard parts. */
  notifyDataChanged: (() => void) | null = null;
  /** Called by main.ts when sync progress updates. */
  notifyProgressChanged: ((current: number, total: number, detail: string) => void) | null = null;
  /** Called by main.ts when activity items change. */
  notifyActivityChanged: (() => void) | null = null;

  // ---- Dashboard state ----
  private confirmingReset = false;

  // ---- Wizard state ----
  private wStep = 0;
  private wServerUrl = "";
  private wPassword = "";
  private wPasswordValid: boolean | null = null; // null=unchecked, true=ok, false=wrong
  private wDeviceName = "";
  private wStrategy: InitialSyncStrategy = "merge";
  private wSyncPlugins = true;
  private wSyncSettings = true;
  private wSyncWorkspace = false;
  private wSyncAllFileTypes = true;
  private wErrorMsg = "";
  private serverReachable = false;
  private serverInitialized: boolean | null = null;
  private pingDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Server initialization wizard state
  private wPasswordConfirm = "";

  // Sync preview state
  private previewPlan: import("./sync/sync-engine").SyncPlan | null = null;
  private previewError = "";
  private previewLoading = false;
  private wApplying = false;

  constructor(app: App, plugin: AdvancedSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.resetWizard();
  }

  /** Reset wizard to initial state. */
  resetWizard(): void {
    const s = this.plugin.settings;
    this.wStep = 0;
    this.wServerUrl = s.serverUrl || "";
    this.wPassword = "";
    this.wPasswordConfirm = "";
    this.wDeviceName = s.deviceName || getHostname();
    this.wStrategy = "merge";
    this.wSyncPlugins = s.syncPlugins;
    this.wSyncSettings = s.syncSettings;
    this.wSyncWorkspace = s.syncWorkspace;
    this.wSyncAllFileTypes = s.syncAllFileTypes ?? true;
    this.wErrorMsg = "";
    this.serverReachable = false;
    this.serverInitialized = null;
    this.wPasswordValid = null;
    this.previewPlan = null;
    this.previewError = "";
    this.previewLoading = false;
    this.wApplying = false;
  }

  hide(): void {
    if (this.pingDebounceTimer) {
      clearTimeout(this.pingDebounceTimer);
      this.pingDebounceTimer = null;
    }
    this.confirmingReset = false;
    this.notifyDataChanged = null;
    this.notifyProgressChanged = null;
    this.notifyActivityChanged = null;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("as-settings-container");

    // Show wizard if not set up yet, OR if the wizard is actively in progress
    // (wStep > 0 means the user clicked past Welcome, including mid-connect/preview)
    if (!this.plugin.settings.setupComplete || this.wStep > 0) {
      this.renderWizard(containerEl);
    } else {
      this.renderDashboard(containerEl);
    }
  }

  // ================================================================
  // INLINE WIZARD — Single password + Sync Preview
  // ================================================================

  private renderWizard(container: HTMLElement): void {
    const stepNames = ["Welcome", "Server", "Password", "Device", "Sync", "Summary", "Preview", "Apply"];
    const stepIcons = ["refresh-cw", "server", "lock", "monitor", "sliders", "list", "eye", "check-circle"];

    // Step indicator (dots + labels)
    const indicator = container.createDiv("as-wizard-indicator");
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const stepEl = indicator.createDiv("as-wizard-step-container");
      const iconWrap = stepEl.createSpan("as-wizard-step-icon");
      const isApplying = i === 7 && this.wStep === 7 && this.wApplying;
      setIcon(iconWrap, isApplying ? "loader-2" : stepIcons[i]);
      if (i === this.wStep) iconWrap.addClass("active");
      if (i < this.wStep) iconWrap.addClass("completed");
      if (isApplying) iconWrap.addClass("as-wizard-step-spinning");
      stepEl.createDiv({ text: stepNames[i], cls: "as-wizard-step-label" });
    }

    // Card with in-card navigation row at the top
    const card = container.createDiv("as-wizard-card");

    // Keyboard navigation: Enter advances wizard on most steps.
    // (Avoids requiring precise taps on mobile.)
    card.addEventListener(
      "keydown",
      (ev: KeyboardEvent) => {
        if (ev.key !== "Enter" || ev.shiftKey || (ev as any).isComposing) return;
        const t = ev.target as any;
        if (t instanceof HTMLTextAreaElement) return;

        if (this.wStep >= 0 && this.wStep <= 4) {
          ev.preventDefault();
          void this.wNext();
        } else if (this.wStep === 5) {
          ev.preventDefault();
          void this.wConnect();
        }
      },
      true
    );

    const cardNav = card.createDiv("as-wizard-card-nav");

    // Back arrow (left)
    if (this.wStep > 0 && this.wStep < 7) {
      const backBtn = cardNav.createEl("button", { cls: "as-wizard-arrow-btn" });
      setIcon(backBtn, "chevron-left");
      backBtn.addEventListener("click", () => { this.wStep--; this.display(); });
    } else {
      cardNav.createDiv("as-wizard-arrow-placeholder");
    }

    // Step name + icon as big header (centre)
    const titleEl = cardNav.createDiv("as-wizard-step-title-inline");
    titleEl.createSpan({ text: stepNames[this.wStep] });

    // Next arrow (right) — steps 0-4 only
    if (this.wStep < 5) {
      const nextBtn = cardNav.createEl("button", { cls: "as-wizard-arrow-btn as-wizard-next-btn" });
      setIcon(nextBtn, "chevron-right");
      nextBtn.addEventListener("click", () => this.wNext());
    } else {
      cardNav.createDiv("as-wizard-arrow-placeholder");
    }

    // Body
    const body = card.createDiv("as-wizard-inline-body");
    switch (this.wStep) {
      case 0: this.wRenderWelcome(body); break;
      case 1: this.wRenderFindServer(body); break;
      case 2: this.wRenderPassword(body); break;
      case 3: this.wRenderDeviceName(body); break;
      case 4: this.wRenderSyncSetup(body); break;
      case 5: this.wRenderSummary(body); break;
      case 6: this.wRenderSyncPreview(body); break;
      case 7: this.wRenderApply(body); break;
    }
  }

  private wRenderWelcome(body: HTMLElement): void {
    const title = body.createDiv("as-wizard-title");
    title.createSpan({ text: "Advanced Sync Setup" });
    body.createEl("p", {
      text: "This wizard will set up encrypted vault synchronization across your devices.",
      cls: "as-wizard-desc",
    });
    const features: Array<{ icon: string; text: string }> = [
      { icon: "lock",        text: "End-to-end encrypted — the server never sees your data" },
      { icon: "refresh-cw",  text: "Sync notes, plugins, and settings across all devices" },
      { icon: "zap",         text: "Real-time — changes appear on other devices within seconds" },
      { icon: "server",      text: "Self-hosted — your data stays on your own server" },
    ];
    const list = body.createDiv("as-wizard-feature-list");
    for (const f of features) {
      const row = list.createDiv("as-wizard-feature-row");
      const iconEl = row.createSpan("as-wizard-feature-icon");
      setIcon(iconEl, f.icon);
      row.createSpan({ text: f.text, cls: "as-wizard-feature-text" });
    }
  }

  private wRenderFindServer(body: HTMLElement): void {
    // Auto-discovery
    if (isDiscoveryAvailable()) {
      const scanRow = body.createDiv("as-scan-header");
      const spinner = scanRow.createDiv("as-scan-spinner");
      setIcon(spinner, "refresh-cw");
      const scanLbl = scanRow.createSpan({ text: "Scanning network...", cls: "as-scan-label" });
      const listContainer = body.createDiv("as-server-list-container");
      const listEl = listContainer.createDiv("as-server-list");

      discoverServers(5000).then((servers) => {
        spinner.remove();
        scanLbl.textContent = servers.length
          ? `Found ${servers.length} server${servers.length > 1 ? "s" : ""} — click to select`
          : "No servers found on the network";

        if (servers.length > 0) {
          for (const sv of servers) {
            const item = listEl.createDiv("as-server-item");
            setIcon(item.createSpan("as-server-icon"), "server");
            const info = item.createDiv("as-server-item-info");
            info.createSpan({ text: sv.hostname, cls: "as-server-item-name" });
            info.createSpan({ text: `${sv.ip}:${sv.port}`, cls: "as-server-item-ip" });
            item.addEventListener("click", () => {
              this.wServerUrl = `ws://${sv.ip}:${sv.port}/sync`;
              listEl.querySelectorAll(".as-server-item").forEach((el) => el.removeClass("selected"));
              item.addClass("selected");
              const hi = body.querySelector(".as-host-input") as HTMLInputElement;
              const pi = body.querySelector(".as-port-input") as HTMLInputElement;
              if (hi) { hi.value = sv.ip; }
              if (pi) { pi.value = String(sv.port); }
              triggerPing();
            });
          }
        }
      });
    } else {
      body.createEl("p", { text: "Auto-discovery is not available on mobile.", cls: "as-wizard-desc" });
    }

    // Manual entry
    let initialHost = "";
    let initialPort = "8443";
    if (this.wServerUrl) {
      const m = this.wServerUrl.match(/wss?:\/\/([^:/]+):?(\d+)?/);
      if (m) { initialHost = m[1] ?? ""; initialPort = m[2] ?? "8443"; }
    }

    const row = body.createDiv("as-field-group");

    // Label row — "Host or IP" + inline ping status icon
    const labelRow = row.createDiv("as-field-label-row");
    labelRow.createEl("label", { text: "Host or IP", cls: "as-field-label" });
    const statusInline = labelRow.createSpan("as-server-status-inline");

    const inputRow = row.createDiv("as-input-row");
    const hostInput = inputRow.createEl("input", {
      type: "text", placeholder: "IP or hostname",
      cls: "as-input as-host-input",
    });
    hostInput.value = initialHost;

    inputRow.createSpan({ text: ":", cls: "as-port-sep" });

    const portInput = inputRow.createEl("input", {
      type: "text", placeholder: "8443",
      cls: "as-input as-port-input",
    });
    portInput.value = initialPort;

    const urlLabel = row.createDiv("as-url-label");
    const initLabel = row.createDiv("as-init-label");
    initLabel.style.display = "none";

    const updateNextBtn = () => {
      const nextBtn = this.containerEl.querySelector(".as-wizard-next-btn") as HTMLButtonElement | null;
      if (nextBtn) {
        nextBtn.disabled = !this.serverReachable;
        nextBtn.toggleClass("as-btn-disabled", !this.serverReachable);
      }
    };

    const updateStatusIcon = (status: "pinging" | "ok" | "fail" | "none") => {
      statusInline.empty();
      statusInline.className = "as-server-status-inline";
      if (status === "pinging") {
        statusInline.addClass("as-status-pinging");
        setIcon(statusInline, "loader");
      } else if (status === "ok") {
        statusInline.addClass("as-status-ok");
        setIcon(statusInline, "check");
      } else if (status === "fail") {
        statusInline.addClass("as-status-fail");
        setIcon(statusInline, "x");
      }
    };

    const doPing = async () => {
      const h = hostInput.value.trim();
      const p = portInput.value.trim() || "8443";
      if (!h) {
        this.wServerUrl = "";
        urlLabel.style.display = "none";
        initLabel.style.display = "none";
        this.serverReachable = false;
        this.serverInitialized = null;
        updateStatusIcon("none");
        updateNextBtn();
        return;
      }
      this.wServerUrl = `ws://${h}:${p}/sync`;
      urlLabel.textContent = this.wServerUrl;
      urlLabel.style.display = "block";
      updateStatusIcon("pinging");
      const httpUrl = toHttpUrl(this.wServerUrl);
      try {
        const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(5000) });
        this.serverReachable = res.ok;
        if (res.ok) {
          try {
            const json = (await res.json()) as { initialized?: boolean };
            this.serverInitialized = typeof json.initialized === "boolean" ? json.initialized : null;
          } catch {
            this.serverInitialized = null;
          }
        } else {
          this.serverInitialized = null;
        }
        updateStatusIcon(this.serverReachable ? "ok" : "fail");
      } catch {
        this.serverReachable = false;
        this.serverInitialized = null;
        updateStatusIcon("fail");
      }

      if (this.serverReachable && this.serverInitialized === false) {
        initLabel.textContent = "Server not initialized — you'll set a password next.";
        initLabel.style.display = "block";
      } else if (this.serverReachable && this.serverInitialized === true) {
        initLabel.textContent = "Server initialized.";
        initLabel.style.display = "block";
      } else {
        initLabel.style.display = "none";
      }

      updateNextBtn();
    };

    const triggerPing = () => {
      const h = hostInput.value.trim();
      const p = portInput.value.trim() || "8443";
      if (h) {
        this.wServerUrl = `ws://${h}:${p}/sync`;
        urlLabel.textContent = this.wServerUrl;
        urlLabel.style.display = "block";
      } else {
        this.wServerUrl = "";
        urlLabel.style.display = "none";
      }
      this.serverReachable = false;
      this.serverInitialized = null;
      initLabel.style.display = "none";
      updateNextBtn();
      if (this.pingDebounceTimer) clearTimeout(this.pingDebounceTimer);
      if (h) {
        this.pingDebounceTimer = setTimeout(() => doPing(), 500);
      }
    };

    hostInput.addEventListener("input", triggerPing);
    portInput.addEventListener("input", triggerPing);

    if (this.serverReachable && this.wServerUrl) {
      updateStatusIcon("ok");
    } else if (this.wServerUrl) {
      setTimeout(() => doPing(), 100);
    }

    if (this.wServerUrl) {
      urlLabel.textContent = this.wServerUrl;
      urlLabel.style.display = "block";
    }

    setTimeout(() => updateNextBtn(), 0);
    focusAndScroll(hostInput);
  }

  private wRenderPassword(body: HTMLElement): void {
    const callout = body.createDiv("as-wizard-callout");
    callout.textContent = this.serverInitialized === false
      ? "This server has not been initialized yet. Set a server password now. This password will also encrypt your vault data. Keep it safe — if you lose it, your data cannot be recovered."
      : "This password authenticates you with the server and encrypts your vault data. Keep it safe — if you lose it, your data cannot be recovered.";

    if (this.wErrorMsg) {
      body.createDiv({ text: this.wErrorMsg, cls: "as-error", attr: { style: "display:block; margin-bottom:8px;" } });
    }

    const g = body.createDiv("as-field-group");
    const labelRow = g.createDiv("as-field-label-row");
    labelRow.createEl("label", { text: "Password", cls: "as-field-label" });
    const pwStatus = labelRow.createSpan("as-server-status-inline");

    const wrapper = g.createDiv("as-password-wrapper");
    const input = wrapper.createEl("input", { type: "password", placeholder: "Server & encryption password", cls: "as-input as-password-input" });
    input.value = this.wPassword;

    const toggle = wrapper.createDiv("as-eye-toggle");
    setIcon(toggle, "eye");
    toggle.addEventListener("click", () => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      toggle.empty(); setIcon(toggle, hidden ? "eye-off" : "eye");
    });

    // Instant password validation against the server (only when initialized)
    let pwValidateTimer: ReturnType<typeof setTimeout> | null = null;
    const validatePw = async () => {
      const password = input.value;
      if (!password || !this.wServerUrl) { pwStatus.empty(); return; }
      if (this.serverInitialized === false) return;

      pwStatus.empty();
      const pinging = pwStatus.createSpan("as-status-pinging");
      setIcon(pinging, "loader");
      try {
        const hash = await sha256String(password);
        const res = await fetch(`${toHttpUrl(this.wServerUrl)}/api/ui-auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passwordHash: hash }),
          signal: AbortSignal.timeout(5000),
        });
        this.wPasswordValid = res.ok;
        pwStatus.empty();
        if (res.ok) {
          const ok = pwStatus.createSpan("as-status-ok");
          setIcon(ok, "check");
        } else {
          const fail = pwStatus.createSpan("as-status-fail");
          setIcon(fail, "x");
        }
      } catch {
        this.wPasswordValid = null;
        pwStatus.empty();
      }

      // Reflect on next button
      const nextBtn = this.containerEl.querySelector(".as-wizard-next-btn") as HTMLButtonElement | null;
      if (nextBtn) {
        const blocked = this.wPasswordValid === false;
        nextBtn.disabled = blocked;
        nextBtn.toggleClass("as-btn-disabled", blocked);
      }
    };

    // Confirm password UI when server is not initialized
    let confirmInput: HTMLInputElement | null = null;
    let updateInitMatch: (() => void) | null = null;
    if (this.serverInitialized === false) {
      const g2 = body.createDiv("as-field-group");
      g2.createEl("label", { text: "Confirm Password", cls: "as-field-label" });
      const w2 = g2.createDiv("as-password-wrapper");
      confirmInput = w2.createEl("input", { type: "password", placeholder: "Repeat password", cls: "as-input as-password-input" });
      confirmInput.value = this.wPasswordConfirm;
      const t2 = w2.createDiv("as-eye-toggle");
      setIcon(t2, "eye");
      t2.addEventListener("click", () => {
        const hidden = confirmInput!.type === "password";
        confirmInput!.type = hidden ? "text" : "password";
        t2.empty(); setIcon(t2, hidden ? "eye-off" : "eye");
      });

      updateInitMatch = () => {
        pwStatus.empty();
        this.wPasswordValid = null;
        if (!this.wPassword || !this.wPasswordConfirm) return;
        if (this.wPassword === this.wPasswordConfirm) {
          this.wPasswordValid = true;
          const ok = pwStatus.createSpan("as-status-ok");
          setIcon(ok, "check");
        } else {
          this.wPasswordValid = false;
          const fail = pwStatus.createSpan("as-status-fail");
          setIcon(fail, "x");
        }
      };

      confirmInput.addEventListener("input", () => {
        this.wPasswordConfirm = confirmInput!.value;
        updateInitMatch?.();
      });

      // Re-render indicator on first open
      setTimeout(() => updateInitMatch?.(), 0);
    }

    input.addEventListener("input", () => {
      this.wPassword = input.value;
      this.wPasswordValid = null;
      pwStatus.empty();
      if (pwValidateTimer) clearTimeout(pwValidateTimer);
      if (this.serverInitialized === false) {
        updateInitMatch?.();
      } else if (input.value) {
        pwValidateTimer = setTimeout(validatePw, 600);
      }
    });

    // Restore previous validation state visually
    if (this.wPasswordValid === true) {
      const ok = pwStatus.createSpan("as-status-ok"); setIcon(ok, "check");
    } else if (this.wPasswordValid === false) {
      const fail = pwStatus.createSpan("as-status-fail"); setIcon(fail, "x");
    } else if (this.wPassword && this.serverInitialized !== false) {
      setTimeout(validatePw, 100);
    }

    focusAndScroll(input);
  }

  private wRenderDeviceName(body: HTMLElement): void {
    body.createEl("p", { text: "A name to identify this device on the server and in the sync log.", cls: "as-wizard-desc" });

    const g = body.createDiv("as-field-group");
    g.createEl("label", { text: "Device Name", cls: "as-field-label" });
    const input = g.createEl("input", { type: "text", placeholder: "e.g. MacBook, iPhone, Desktop", cls: "as-input" });
    input.value = this.wDeviceName;
    input.addEventListener("input", () => { this.wDeviceName = input.value.trim(); });
    focusAndScroll(input);
  }

  private wRenderSyncSetup(body: HTMLElement): void {

    // New server: initial sync is always "push" (upload this vault) to initialize it.
    // Hide pull/merge options entirely.
    if (this.serverInitialized === false) {
      this.wStrategy = "push";
      body.createEl("p", {
        text: "This server is not initialized yet. Advanced Sync will initialize it by uploading this vault.",
        cls: "as-wizard-desc",
      });
    } else {
      const allFiles = this.app.vault.getFiles();
      const vaultFiles = allFiles.filter(f => !f.path.startsWith(".obsidian/plugins/advanced-sync/"));
      const isEmpty = vaultFiles.length === 0;

      if (isEmpty) {
        body.createEl("p", { text: "This vault is empty. All files from the server will be downloaded.", cls: "as-wizard-desc" });
        this.wStrategy = "pull";
      } else {
        body.createEl("p", {
          text: `This vault has ${vaultFiles.length} file${vaultFiles.length !== 1 ? "s" : ""}. How should it sync with the server?`,
          cls: "as-wizard-desc",
        });
      }

      if (!isEmpty) {
        const cards = body.createDiv("as-strategy-cards");
        const strategies: Array<{ value: InitialSyncStrategy; icon: string; label: string; desc: string; recommended: boolean }> = [
          { value: "pull",  icon: "download",  label: "Pull from server",  desc: "Download everything from the server. Local-only files will be deleted.", recommended: false },
          { value: "merge", icon: "git-merge", label: "Merge",             desc: "Merge notes (newest wins), but always use the server's settings and plugins.", recommended: true },
          { value: "push",  icon: "upload",    label: "Push to server",    desc: "Upload this vault to the server. Server-only files will be removed.", recommended: false },
        ];

        for (const s of strategies) {
          const card = cards.createDiv("as-strategy-card");
          if (s.value === this.wStrategy) card.addClass("selected");
          const hdr = card.createDiv("as-strategy-card-header");
          setIcon(hdr.createSpan("as-strategy-icon"), s.icon);
          hdr.createSpan({ text: s.label, cls: "as-strategy-label" });
          if (s.recommended) hdr.createSpan({ text: "Recommended", cls: "as-strategy-badge" });
          card.createDiv({ text: s.desc, cls: "as-strategy-desc" });
          card.addEventListener("click", () => {
            this.wStrategy = s.value;
            cards.querySelectorAll(".as-strategy-card").forEach(el => el.removeClass("selected"));
            card.addClass("selected");
          });
        }
      }
    }

    // Sync toggles
    const toggleSection = body.createDiv("as-wizard-toggles");
    toggleSection.createDiv({ text: "What to sync", cls: "as-wizard-toggles-title" });
    this.addWizardToggle(toggleSection, "Sync all file types", "Sync all files (off = only .md notes)", this.wSyncAllFileTypes, v => { this.wSyncAllFileTypes = v; });
    this.addWizardToggle(toggleSection, "Sync plugins", "Sync installed plugins (.obsidian/plugins/)", this.wSyncPlugins, v => { this.wSyncPlugins = v; });
    this.addWizardToggle(toggleSection, "Sync settings", "Sync Obsidian settings (appearance, hotkeys, etc.)", this.wSyncSettings, v => { this.wSyncSettings = v; });
    this.addWizardToggle(toggleSection, "Sync workspace", "Sync workspace layout and open files", this.wSyncWorkspace, v => { this.wSyncWorkspace = v; });
  }

  private wRenderSummary(body: HTMLElement): void {
    body.createEl("p", { text: "Review your settings and connect to see a preview of changes.", cls: "as-wizard-desc" });

    const strategyLabels: Record<InitialSyncStrategy, string> = {
      pull: "Pull from server", merge: "Merge (newest wins)", push: "Push to server",
    };

    const summary = body.createDiv("as-summary");
    this.addSummaryRow(summary, "Server",        this.wServerUrl);
    this.addSummaryRow(summary, "Device",         this.wDeviceName);
    this.addSummaryRow(summary, "Initial sync",   strategyLabels[this.wStrategy]);
    this.addSummaryRow(summary, "Sync plugins",   this.wSyncPlugins  ? "Yes" : "No");
    this.addSummaryRow(summary, "Sync settings",  this.wSyncSettings ? "Yes" : "No");
    this.addSummaryRow(summary, "Encryption",     "AES-256-GCM / PBKDF2");

    const startBtn = body.createEl("button", { text: "Connect & Preview", cls: "mod-cta as-start-btn" });
    startBtn.addEventListener("click", () => this.wConnect());
  }

  private wRenderSyncPreview(body: HTMLElement): void {

    if (this.previewLoading) {
      const loading = body.createDiv("as-preview-loading");
      const spinner = loading.createDiv("as-scan-spinner");
      setIcon(spinner, "refresh-cw");
      loading.createSpan({ text: "Connecting and computing changes...", cls: "as-scan-label" });
      return;
    }

    if (this.previewError) {
      body.createDiv({ text: this.previewError, cls: "as-error", attr: { style: "display:block; margin-bottom:12px;" } });
      const retryBtn = body.createEl("button", { text: "Retry", cls: "mod-cta" });
      retryBtn.addEventListener("click", () => this.wConnect());
      return;
    }

    if (!this.previewPlan) {
      body.createEl("p", { text: "No preview available.", cls: "as-wizard-desc" });
      return;
    }

    const plan = this.previewPlan;

    // Stats cards
    const stats = body.createDiv("as-preview-stats");

    const dlStat = stats.createDiv("as-preview-stat as-preview-download");
    dlStat.createDiv({ text: String(plan.toDownload.length), cls: "as-preview-stat-number" });
    dlStat.createDiv({ text: "Download", cls: "as-preview-stat-label" });

    const ulStat = stats.createDiv("as-preview-stat as-preview-upload");
    ulStat.createDiv({ text: String(plan.toUpload.length), cls: "as-preview-stat-number" });
    ulStat.createDiv({ text: "Upload", cls: "as-preview-stat-label" });

    const delStat = stats.createDiv("as-preview-stat as-preview-delete");
    delStat.createDiv({ text: String(plan.toDelete.length), cls: "as-preview-stat-number" });
    delStat.createDiv({ text: "Delete", cls: "as-preview-stat-label" });

    const total = plan.toDownload.length + plan.toUpload.length + plan.toDelete.length;
    if (total === 0) {
      body.createEl("p", { text: "Everything is already in sync! No changes needed.", cls: "as-wizard-desc" });
    } else {
      const totalDlSize = plan.toDownload.reduce((s, f) => s + f.size, 0);
      if (totalDlSize > 0) {
        body.createEl("p", { text: `Total download: ${formatSize(totalDlSize)}`, cls: "as-wizard-desc" });
      }
    }

    // Buttons
    const btnRow = body.createDiv("as-preview-buttons");
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.plugin.syncEngine.disconnect();
      this.wStep = 5;
      this.display();
    });

    const applyBtn = btnRow.createEl("button", { text: "Apply Changes", cls: "mod-cta" });
    applyBtn.addEventListener("click", () => this.wApplySync());
  }

  private wRenderApply(body: HTMLElement): void {
    const state = this.plugin.syncEngine.state;

    if (state === "idle") {
      body.createEl("p", { text: "Sync complete! All files are up to date.", cls: "as-wizard-desc" });
    } else {
      body.createEl("p", { text: "Syncing… Keep this tab open until it finishes.", cls: "as-wizard-desc" });
    }

    // Activity renderer — same component used in the sidebar and dashboard
    const activityContainer = body.createDiv("as-apply-activity");
    const renderer = new SyncActivityRenderer(activityContainer, {
      getActiveItems: () => this.plugin.syncEngine?.activeItems ?? [],
      getHistory: () => {
        const h = this.plugin.syncEngine?.history ?? [];
        return this.plugin.settings.hideObsidianInHistory
          ? h.filter(e => !e.path.startsWith(".obsidian/"))
          : h;
      },
      getState: () => this.plugin.syncEngine?.state ?? "disconnected",
      maxHistoryItems: 50,
    });
    renderer.render();

    // Buttons appear below the activity list once sync is complete
    if (state === "idle") {
      const btnRow = body.createDiv("as-apply-btn-row");

      if (this.plugin.syncEngine.hasObsidianFilesChanged) {
        const reloadBtn = btnRow.createEl("button", { cls: "as-apply-btn as-apply-reload-btn" });
        setIcon(reloadBtn.createSpan(), "refresh-cw");
        reloadBtn.createSpan({ text: "Reload Obsidian" });
        reloadBtn.addEventListener("click", () => {
          const ids = ["app:restart", "app:reload"];
          for (const id of ids) {
            try {
              const cmd = this.app.commands?.findCommand?.(id);
              if (cmd) {
                this.plugin.syncEngine.clearObsidianFilesChanged();
                this.app.commands.executeCommandById(id);
                return;
              }
            } catch {
              // ignore
            }
          }
          new Notice("Advanced Sync: Please restart Obsidian manually to apply .obsidian changes.");
        });
      }

      const doneBtn = btnRow.createEl("button", { text: "Done", cls: "mod-cta as-apply-btn" });
      doneBtn.addEventListener("click", () => {
        this.wStep = 0; // Exit wizard, fall through to dashboard
        this.display();
      });
    }

    this.notifyActivityChanged = () => renderer.refreshActive();
    this.notifyProgressChanged = (current, total, detail) => renderer.setProgress(current, total, detail);
    this.notifyDataChanged = () => {
      renderer.refreshHistory();
      if (this.plugin.syncEngine.state === "idle") {
        this.wApplying = false;
        this.display();
      }
    };
  }

  private addWizardToggle(parent: HTMLElement, label: string, desc: string, initial: boolean, onChange: (v: boolean) => void): void {
    const row = parent.createDiv("as-toggle-row");
    const info = row.createDiv("as-toggle-row-info");
    info.createSpan({ text: label, cls: "as-toggle-row-label" });
    info.createSpan({ text: desc, cls: "as-toggle-row-desc" });
    const lbl = row.createEl("label", { cls: "as-toggle-switch" });
    const cb = lbl.createEl("input", { type: "checkbox" });
    cb.checked = initial;
    lbl.createSpan({ cls: "as-toggle-track" });
    cb.addEventListener("change", () => onChange(cb.checked));
  }

  private addSummaryRow(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv("as-summary-row");
    row.createSpan({ text: label, cls: "as-summary-label" });
    row.createSpan({ text: value, cls: "as-summary-value" });
  }

  private async wNext(): Promise<void> {
    this.wErrorMsg = "";

    switch (this.wStep) {
      case 1:
        if (!this.wServerUrl || !this.serverReachable) return;
        break;
      case 2:
        if (!this.wPassword) { this.wErrorMsg = "Password cannot be empty."; this.display(); return; }
        if (this.serverInitialized === false) {
          if (!this.wPasswordConfirm) { this.wErrorMsg = "Please confirm your password."; this.display(); return; }
          if (this.wPassword !== this.wPasswordConfirm) { this.wErrorMsg = "Passwords do not match."; this.display(); return; }
        }
        break;
      case 3:
        if (!this.wDeviceName) return;
        break;
    }
    this.wStep++;
    this.display();
  }

  /** Connect to server and move to preview step. */
  private async wConnect(): Promise<void> {
    // Save settings first
    Object.assign(this.plugin.settings, {
      serverUrl:           this.wServerUrl,
      deviceName:          this.wDeviceName,
      initialSyncStrategy: this.wStrategy,
      syncPlugins:         this.wSyncPlugins,
      syncSettings:        this.wSyncSettings,
      syncWorkspace:       this.wSyncWorkspace,
      syncAllFileTypes:    this.wSyncAllFileTypes,
      setupComplete:       true,
    });
    await this.plugin.saveSettings();

    this.previewLoading = true;
    this.previewError = "";
    this.previewPlan = null;
    this.wStep = 6;
    this.display();

    try {
      // Initialize the server password if needed
      if (this.serverInitialized === false) {
        const hash = await sha256String(this.wPassword);
        const res = await fetch(`${toHttpUrl(this.wServerUrl)}/api/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passwordHash: hash }),
          signal: AbortSignal.timeout(8000),
        });

        if (res.status === 409) {
          // Another device likely initialized it first.
          // Switch to normal password mode.
          this.serverInitialized = true;
        } else if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(txt || "Failed to initialize server");
        } else {
          this.serverInitialized = true;
        }
      }

      // Connect with password
      await this.plugin.connectWithPassword(this.wPassword);

      // Wait for sync response with a timeout
      const plan = await new Promise<import("./sync/sync-engine").SyncPlan>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for server response")), 30000);

        // Override the sync response handler temporarily
        const originalHandler = this.plugin.syncEngine["connection"].onSyncResponse;
        const originalStateChange = this.plugin.syncEngine["connection"].onStateChange;

        const restoreHandlers = () => {
          this.plugin.syncEngine["connection"].onSyncResponse = originalHandler;
          this.plugin.syncEngine["connection"].onStateChange = originalStateChange;
        };

        this.plugin.syncEngine["connection"].onSyncResponse = async (msg) => {
          clearTimeout(timeout);
          restoreHandlers();
          try {
            const preview = await this.plugin.syncEngine.computeSyncPreview(msg);
            resolve(preview);
          } catch (err: any) {
            reject(err);
          }
        };

        // Also handle auth errors
        this.plugin.syncEngine["connection"].onStateChange = (state, error) => {
          if (state === "error") {
            clearTimeout(timeout);
            restoreHandlers();
            reject(new Error(error || "Connection failed"));
          } else {
            originalStateChange(state, error);
          }
        };
      });

      this.previewPlan = plan;
      this.previewLoading = false;
      this.display();
    } catch (err: any) {
      this.previewLoading = false;
      this.previewError = err.message || "Failed to connect";
      this.plugin.syncEngine.disconnect();
      this.display();
    }
  }

  /** Apply the previewed sync plan. */
  private async wApplySync(): Promise<void> {
    if (!this.previewPlan) return;

    this.wApplying = true;
    this.wStep = 7;
    this.display();

    // Re-trigger the sync response handling by requesting sync again
    // The sync engine will handle it normally
    await this.plugin.syncEngine.applySyncPlan(this.previewPlan);
  }

  // ================================================================
  // DASHBOARD
  // ================================================================

  private renderDashboard(container: HTMLElement): void {
    // Reconnect banner — shown when session has expired or credentials are missing
    if (!this.plugin.settings.authToken || !this.plugin.settings.encryptionKeyB64) {
      const banner = container.createDiv("as-dash-reconnect-banner");
      banner.createSpan({ text: "Session expired — re-enter your password to reconnect.", cls: "as-dash-reconnect-msg" });
      const reconnectBtn = banner.createEl("button", { text: "Reconnect", cls: "mod-cta" });
      reconnectBtn.addEventListener("click", () => {
        this.resetWizard();
        this.serverInitialized = true; // Server is already initialized
        this.wStep = 2;                // Jump straight to password entry
        this.display();
      });
    }

    // Dashboard section
    container.createDiv({ cls: "as-settings-section-label", text: "Dashboard" });
    const dash = container.createDiv("as-settings-dash");

    // Sync activity card — badge in card header, content in card body
    const logCard = dash.createDiv("as-dash-card");
    const logCardHeader = logCard.createDiv("as-dash-card-header");
    logCardHeader.createSpan({ text: "Recent Changes", cls: "as-dash-card-title" });
    const logBadgeSlot = logCardHeader.createDiv();
    const logBody = logCard.createDiv("as-dash-log");

    const activityRenderer = new SyncActivityRenderer(logBody, {
      getActiveItems: () => this.plugin.syncEngine?.activeItems ?? [],
      getHistory: () => {
        let h = this.plugin.syncEngine?.history ?? [];
        if (this.plugin.settings.hideObsidianInHistory) {
          h = h.filter(e => !e.path.startsWith(".obsidian/"));
        }
        return h;
      },
      getState: () => this.plugin.syncEngine?.state ?? "disconnected",
      maxHistoryItems: 15,
      badgeContainer: logBadgeSlot,
      onNavigate: (path) => { this.app.workspace.openLinkText(path, "", false); },
      isConfigured: () => this.plugin.settings.setupComplete,
    });
    activityRenderer.render();

    // Devices card — live WebSocket push, no HTTP polling
    const devCard = dash.createDiv("as-dash-card");
    devCard.createDiv("as-dash-card-header").createSpan({ text: "Devices", cls: "as-dash-card-title" });
    const devBody = devCard.createDiv("as-dash-devices");

    const renderDevices = (clients?: ClientSession[]) => {
      devBody.empty();
      const all = clients ?? this.plugin.syncEngine?.clientList ?? [];
      if (all.length === 0) {
        devBody.createDiv({ text: "No devices connected", cls: "as-dash-empty" });
        return;
      }
      for (const dev of all) {
        const row = devBody.createDiv("as-dash-device-row");
        row.createSpan({ cls: `as-dash-device-dot ${dev.isOnline ? "as-online" : "as-offline"}` });
        const info = row.createDiv("as-dash-device-info");
        info.createSpan({ text: dev.deviceName, cls: "as-dash-device-name" });
        info.createSpan({
          text: `${dev.ip} · ${dev.isOnline ? "online" : formatTimeAgo(dev.lastSeen)}`,
          cls: "as-dash-device-meta",
        });
        if (dev.clientId !== this.plugin.settings.clientId) {
          const kickBtn = row.createEl("button", { cls: "as-btn-kick-icon" });
          setIcon(kickBtn, "x");
          kickBtn.title = `Remove ${dev.deviceName}`;
          kickBtn.addEventListener("click", () => {
            if (window.confirm(`Remove "${dev.deviceName}" from sync?\n\nThey will be disconnected and need to re-enter the password to reconnect.`)) {
              this.plugin.syncEngine.kickClient(dev.clientId);
            }
          });
        } else if (dev.clientId === this.plugin.settings.clientId) {
          row.createSpan({ text: "This device", cls: "as-badge-online" });
        }
      }
    };
    renderDevices();

    // Wire up live callbacks
    this.notifyDataChanged = () => {
      activityRenderer.refreshActive();
    };
    this.notifyProgressChanged = (current, total, detail) => {
      activityRenderer.setProgress(current, total, detail);
    };
    this.notifyActivityChanged = () => {
      activityRenderer.refreshActive();
    };

    // Listen for client list updates from sync engine
    const originalClientListCb = this.plugin.syncEngine.onClientListChange;
    this.plugin.syncEngine.onClientListChange = (clients) => {
      originalClientListCb(clients);
      renderDevices(clients);
    };

    // Connection settings
    container.createDiv({ cls: "as-settings-section-label", text: "Connection" });
    new Setting(container).setName("Server URL").setDesc("WebSocket URL of the sync server")
      .addText(t => { t.setValue(this.plugin.settings.serverUrl).setPlaceholder("ws://10.0.0.1:8443/sync"); t.onChange(async v => { this.plugin.settings.serverUrl = v.trim(); await this.plugin.saveSettings(); }); });
    new Setting(container).setName("Device name").setDesc("Display name for this device on the server")
      .addText(t => { t.setValue(this.plugin.settings.deviceName); t.onChange(async v => { this.plugin.settings.deviceName = v.trim(); await this.plugin.saveSettings(); }); });
    new Setting(container).setName("Auto-connect").setDesc("Automatically connect when Obsidian starts")
      .addToggle(t => { t.setValue(this.plugin.settings.autoConnect); t.onChange(async v => { this.plugin.settings.autoConnect = v; await this.plugin.saveSettings(); }); });

    // Sync options
    container.createDiv({ cls: "as-settings-section-label", text: "Sync Options" });
    new Setting(container).setName("Sync all file types").setDesc("Sync all files (off = only .md notes; .obsidian/ is controlled separately)")
      .addToggle(t => { t.setValue(this.plugin.settings.syncAllFileTypes ?? true); t.onChange(async v => { this.plugin.settings.syncAllFileTypes = v; await this.plugin.saveSettings(); }); });
    new Setting(container).setName("Sync plugins").setDesc("Synchronize installed plugins across devices")
      .addToggle(t => { t.setValue(this.plugin.settings.syncPlugins); t.onChange(async v => { this.plugin.settings.syncPlugins = v; await this.plugin.saveSettings(); }); });
    new Setting(container).setName("Sync settings").setDesc("Synchronize Obsidian settings (.obsidian/*.json)")
      .addToggle(t => { t.setValue(this.plugin.settings.syncSettings); t.onChange(async v => { this.plugin.settings.syncSettings = v; await this.plugin.saveSettings(); }); });
    new Setting(container).setName("Sync workspace").setDesc("Synchronize workspace layout (workspace.json)")
      .addToggle(t => { t.setValue(this.plugin.settings.syncWorkspace); t.onChange(async v => { this.plugin.settings.syncWorkspace = v; await this.plugin.saveSettings(); }); });
    new Setting(container).setName("Excluded paths").setDesc("Patterns to exclude (one per line). Supports * and **.")
      .addTextArea(ta => {
        ta.setValue(this.plugin.settings.excludePatterns.join("\n")).setPlaceholder("e.g.\n*.tmp\n.trash/**");
        ta.inputEl.rows = 3;
        ta.onChange(async v => { this.plugin.settings.excludePatterns = v.split("\n").map(s => s.trim()).filter(Boolean); await this.plugin.saveSettings(); });
      });

    // History display
    container.createDiv({ cls: "as-settings-section-label", text: "History Display" });
    new Setting(container).setName("Hide .obsidian/ in Recent Changes").setDesc("Filter out Obsidian config file changes from all history views")
      .addToggle(t => { t.setValue(this.plugin.settings.hideObsidianInHistory ?? false); t.onChange(async v => { this.plugin.settings.hideObsidianInHistory = v; await this.plugin.saveSettings(); this.plugin.refreshHistoryViews(); }); });

    // Advanced
    container.createDiv({ cls: "as-settings-section-label", text: "Advanced" });
    new Setting(container).setName("Force full sync").setDesc("Re-sync all files from scratch")
      .addButton(btn => { btn.setButtonText("Force Sync"); btn.onClick(() => this.plugin.syncEngine.forceSync()); });
    if (this.confirmingReset) {
      const row = container.createDiv("as-confirm-reset-row");
      row.createSpan({ text: "All credentials and settings will be deleted. Vault files are not affected.", cls: "as-confirm-reset-msg" });
      const btns = row.createDiv("as-confirm-reset-btns");
      btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
        this.confirmingReset = false;
        this.display();
      });
      const confirmBtn = btns.createEl("button", { text: "Confirm Reset", cls: "mod-warning" });
      confirmBtn.addEventListener("click", async () => {
        this.confirmingReset = false;
        this.plugin.syncEngine.destroy();
        try {
          const dataPath = `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/data.json`;
          await this.plugin.app.vault.adapter.remove(dataPath);
        } catch { /* file may not exist */ }
        await this.plugin.loadSettings();
        this.resetWizard();
        this.display();
      });
    } else {
      new Setting(container).setName("Reset sync state").setDesc("Clear all local sync state. Your vault files are not deleted.")
        .addButton(btn => {
          btn.setButtonText("Reset").setWarning();
          btn.onClick(() => {
            this.confirmingReset = true;
            this.display();
          });
        });
    }
  }
}
