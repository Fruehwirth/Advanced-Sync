/**
 * Multi-step setup wizard for Advanced Sync.
 * Steps: Welcome → Find Server → Server Password → Encryption Password
 *        → Device Name → Sync Setup → Summary
 */

import { App, Modal, setIcon } from "obsidian";
import { sha256String } from "../crypto/encryption";
import { discoverServers, isDiscoveryAvailable } from "../network/discovery";
import { MessageType, PROTOCOL_VERSION } from "@vault-sync/shared/protocol";
import type { DiscoveredServer } from "../network/discovery";
import type { AdvancedSyncSettings, InitialSyncStrategy } from "../types";

export interface WizardResult {
  settings: Partial<AdvancedSyncSettings>;
  encryptionPassword: string;
}

const TOTAL_STEPS = 7;

export class SetupWizardModal extends Modal {
  private currentStep = 0;
  private resolvePromise: ((result: WizardResult | null) => void) | null = null;

  // Collected data
  private serverUrl = "";
  private serverPassword = "";
  private serverPasswordHash = "";
  private encryptionPassword = "";
  private deviceName = "";
  private discoveredServers: DiscoveredServer[] = [];
  private syncStrategy: InitialSyncStrategy = "merge";
  private syncPlugins: boolean;
  private syncSettings: boolean;
  private syncWorkspace: boolean;
  private errorEl: HTMLElement | null = null;
  private serverReachable = false;
  private pingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private authError = "";

  private settings: AdvancedSyncSettings;

  constructor(app: App, settings: AdvancedSyncSettings) {
    super(app);
    this.settings = settings;
    this.deviceName = settings.deviceName || this.getDefaultDeviceName();
    // Inherit existing toggle state
    this.syncPlugins = settings.syncPlugins;
    this.syncSettings = settings.syncSettings;
    this.syncWorkspace = settings.syncWorkspace;
  }

  static open(
    app: App,
    settings: AdvancedSyncSettings
  ): Promise<WizardResult | null> {
    return new Promise((resolve) => {
      const modal = new SetupWizardModal(app, settings);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    this.modalEl.addClass("as-wizard-modal");
    this.renderStep();
  }

  onClose(): void {
    if (this.pingDebounceTimer) clearTimeout(this.pingDebounceTimer);
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }

  private renderStep(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Step indicator
    const indicator = contentEl.createDiv("as-wizard-indicator");
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const dot = indicator.createSpan("as-wizard-dot");
      if (i === this.currentStep) dot.addClass("active");
      if (i < this.currentStep) dot.addClass("completed");
    }

    const body = contentEl.createDiv("as-wizard-body");

    switch (this.currentStep) {
      case 0: this.renderWelcome(body); break;
      case 1: this.renderFindServer(body); break;
      case 2: this.renderServerPassword(body); break;
      case 3: this.renderEncryptionPassword(body); break;
      case 4: this.renderDeviceName(body); break;
      case 5: this.renderSyncSetup(body); break;
      case 6: this.renderSummary(body); break;
    }

    // Navigation buttons
    const nav = contentEl.createDiv("as-wizard-nav");

    if (this.currentStep > 0) {
      const backBtn = nav.createEl("button", { text: "Back" });
      backBtn.addEventListener("click", () => {
        this.currentStep--;
        this.renderStep();
      });
    } else {
      nav.createDiv();
    }

    if (this.currentStep < TOTAL_STEPS - 1) {
      const nextBtn = nav.createEl("button", { text: "Next", cls: "mod-cta" });
      nextBtn.addEventListener("click", () => this.nextStep());
    }
  }

  // ---- Step renderers ----

  private renderWelcome(body: HTMLElement): void {
    const title = body.createDiv("as-wizard-title");
    setIcon(title.createSpan("as-wizard-icon"), "refresh-cw");
    title.createSpan({ text: "Advanced Sync Setup" });

    body.createEl("p", {
      text: "This wizard will help you set up encrypted vault synchronization.",
      cls: "as-wizard-desc",
    });

    const features = body.createEl("ul", { cls: "as-wizard-features" });
    features.createEl("li", { text: "End-to-end encrypted — server never sees your data" });
    features.createEl("li", { text: "Sync files, plugins, and settings across devices" });
    features.createEl("li", { text: "Real-time sync with automatic conflict resolution" });
    features.createEl("li", { text: "Self-hosted — your data stays on your server" });
  }

  private renderFindServer(body: HTMLElement): void {
    const titleRow = body.createDiv({ attr: { style: "display: flex; align-items: center; gap: 6px;" } });
    titleRow.createEl("h3", { text: "Find Server", attr: { style: "margin: 0;" } });
    const statusInline = titleRow.createSpan("as-server-status-inline");

    const toHttpUrl = (wsUrl: string) =>
      wsUrl.replace("wss://", "https://").replace("ws://", "http://").replace(/\/sync$/, "");

    // ---- Auto-discovery ----
    if (isDiscoveryAvailable()) {
      const scanHeader = body.createDiv("as-scan-header");
      const spinnerEl = scanHeader.createDiv("as-scan-spinner");
      setIcon(spinnerEl, "refresh-cw");
      const scanLabel = scanHeader.createSpan({ text: "Scanning all networks...", cls: "as-scan-label" });

      const listEl = body.createDiv("as-server-list");

      discoverServers(5000).then((servers) => {
        this.discoveredServers = servers;
        spinnerEl.remove();
        scanLabel.textContent = servers.length
          ? `Found ${servers.length} server${servers.length > 1 ? "s" : ""}`
          : "No servers found automatically";

        if (servers.length > 0) {
          listEl.empty();
          for (const server of servers) {
            const item = listEl.createDiv("as-server-item");
            setIcon(item.createSpan("as-server-icon"), "server");
            const info = item.createDiv("as-server-item-info");
            info.createSpan({ text: server.hostname, cls: "as-server-item-name" });
            info.createSpan({ text: `${server.ip}:${server.port}`, cls: "as-server-item-ip" });
            item.addEventListener("click", () => {
              listEl.querySelectorAll(".as-server-item").forEach((el) => el.removeClass("selected"));
              item.addClass("selected");
              setHostInput(server.ip, server.port);
              triggerPing();
            });
          }
        }
      });
    } else {
      body.createEl("p", {
        text: "Auto-discovery is not available on mobile.",
        cls: "as-wizard-desc",
      });
    }

    // ---- Manual entry ----
    body.createEl("h4", { text: "Server Address", attr: { style: "margin: 12px 0 6px;" } });

    const inputGroup = body.createDiv("as-field-group");
    inputGroup.createEl("label", { text: "Host / IP", cls: "as-field-label" });

    const inputRow = inputGroup.createDiv("as-input-row");

    let initialHost = "";
    let initialPort = "8443";
    if (this.serverUrl) {
      const m = this.serverUrl.match(/ws:\/\/([^:/]+):?(\d+)?\/sync/);
      if (m) { initialHost = m[1] ?? ""; initialPort = m[2] ?? "8443"; }
    }

    const hostInput = inputRow.createEl("input", {
      type: "text",
      placeholder: "10.8.0.1 or fruehwirth.online",
      cls: "as-input as-manual-url",
      attr: { style: "flex:1" },
    });
    hostInput.value = initialHost;

    inputRow.createSpan({ text: ":", attr: { style: "padding: 0 2px; color: var(--text-faint);" } });

    const portInput = inputRow.createEl("input", {
      type: "text",
      placeholder: "8443",
      cls: "as-input",
      attr: { style: "width:48px; flex-shrink:0;" },
    });
    portInput.value = initialPort;

    const urlLabel = inputGroup.createDiv("as-url-label");

    const updateNextBtn = () => {
      const nextBtn = this.contentEl.querySelector(".as-wizard-nav .mod-cta") as HTMLButtonElement | null;
      if (nextBtn) {
        if (this.serverReachable) {
          nextBtn.disabled = false;
          nextBtn.removeClass("as-btn-disabled");
        } else {
          nextBtn.disabled = true;
          nextBtn.addClass("as-btn-disabled");
        }
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
        this.serverUrl = "";
        urlLabel.style.display = "none";
        this.serverReachable = false;
        updateStatusIcon("none");
        updateNextBtn();
        return;
      }
      this.serverUrl = `ws://${h}:${p}/sync`;
      urlLabel.textContent = `→  ${this.serverUrl}`;
      urlLabel.style.display = "block";
      updateStatusIcon("pinging");
      const httpUrl = toHttpUrl(this.serverUrl);
      try {
        const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(5000) });
        this.serverReachable = res.ok;
        updateStatusIcon(res.ok ? "ok" : "fail");
      } catch {
        this.serverReachable = false;
        updateStatusIcon("fail");
      }
      updateNextBtn();
    };

    const triggerPing = () => {
      const h = hostInput.value.trim();
      const p = portInput.value.trim() || "8443";
      if (h) {
        this.serverUrl = `ws://${h}:${p}/sync`;
        urlLabel.textContent = `→  ${this.serverUrl}`;
        urlLabel.style.display = "block";
      } else {
        this.serverUrl = "";
        urlLabel.style.display = "none";
      }
      this.serverReachable = false;
      updateNextBtn();
      if (this.pingDebounceTimer) clearTimeout(this.pingDebounceTimer);
      if (h) {
        this.pingDebounceTimer = setTimeout(() => doPing(), 500);
      }
    };

    const setHostInput = (host: string, port: number) => {
      hostInput.value = host;
      portInput.value = String(port);
    };

    hostInput.addEventListener("input", triggerPing);
    portInput.addEventListener("input", triggerPing);

    // Initial state
    if (this.serverReachable && this.serverUrl) {
      updateStatusIcon("ok");
    } else if (this.serverUrl) {
      setTimeout(() => doPing(), 100);
    }

    if (this.serverUrl) {
      urlLabel.textContent = `→  ${this.serverUrl}`;
      urlLabel.style.display = "block";
    }

    setTimeout(() => updateNextBtn(), 0);
  }

  private renderServerPassword(body: HTMLElement): void {
    body.createEl("h3", { text: "Server Password" });
    body.createEl("p", { text: "Enter the password configured on your sync server.", cls: "as-wizard-desc" });

    if (this.authError) {
      body.createDiv({ text: this.authError, cls: "as-auth-error" });
    }

    const inputGroup = body.createDiv("as-field-group");
    inputGroup.createEl("label", { text: "Server Password", cls: "as-field-label" });
    const pw = inputGroup.createDiv("as-password-wrapper");
    const input = pw.createEl("input", { type: "password", placeholder: "Server password", cls: "as-input as-password-input" });
    input.value = this.serverPassword;
    input.addEventListener("input", () => { this.serverPassword = input.value; });

    const toggle = pw.createDiv("as-eye-toggle");
    setIcon(toggle, "eye");
    toggle.addEventListener("click", () => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      toggle.empty(); setIcon(toggle, hidden ? "eye-off" : "eye");
    });
    setTimeout(() => input.focus(), 50);
  }

  private renderEncryptionPassword(body: HTMLElement): void {
    body.createEl("h3", { text: "Encryption Password" });
    body.createEl("p", {
      text: "This password encrypts your vault data. The server never sees it. If you lose this password, your data cannot be recovered.",
      cls: "as-wizard-desc as-warning",
    });

    const g1 = body.createDiv("as-field-group");
    g1.createEl("label", { text: "Encryption Password", cls: "as-field-label" });
    const w1 = g1.createDiv("as-password-wrapper");
    const i1 = w1.createEl("input", { type: "password", placeholder: "Encryption password", cls: "as-input as-password-input" });
    i1.value = this.encryptionPassword;
    i1.addEventListener("input", () => { this.encryptionPassword = i1.value; });
    const t1 = w1.createDiv("as-eye-toggle");
    setIcon(t1, "eye");
    t1.addEventListener("click", () => {
      const hidden = i1.type === "password";
      i1.type = hidden ? "text" : "password";
      t1.empty(); setIcon(t1, hidden ? "eye-off" : "eye");
    });

    const g2 = body.createDiv("as-field-group");
    g2.createEl("label", { text: "Confirm Password", cls: "as-field-label" });
    const i2 = g2.createEl("input", { type: "password", placeholder: "Confirm encryption password", cls: "as-input" });
    (this as any)._confirmInput = i2;

    this.errorEl = body.createDiv("as-error");
    this.errorEl.style.display = "none";
    setTimeout(() => i1.focus(), 50);
  }

  private renderDeviceName(body: HTMLElement): void {
    body.createEl("h3", { text: "Device Name" });
    body.createEl("p", { text: "A name for this device to identify it on the server.", cls: "as-wizard-desc" });

    const g = body.createDiv("as-field-group");
    g.createEl("label", { text: "Device Name", cls: "as-field-label" });
    const input = g.createEl("input", { type: "text", placeholder: "e.g., MacBook Pro, iPad", cls: "as-input" });
    input.value = this.deviceName;
    input.addEventListener("input", () => { this.deviceName = input.value.trim(); });
    setTimeout(() => input.focus(), 50);
  }

  private renderSyncSetup(body: HTMLElement): void {
    body.createEl("h3", { text: "Sync Setup" });

    // Count local vault files (excluding our plugin)
    const allFiles = this.app.vault.getFiles();
    const vaultFiles = allFiles.filter(
      (f) => !f.path.startsWith(".obsidian/plugins/advanced-sync/")
    );
    const isEmpty = vaultFiles.length === 0;
    const fileWord = vaultFiles.length === 1 ? "file" : "files";

    if (isEmpty) {
      body.createEl("p", {
        text: "This vault is empty. All files from the server will be downloaded.",
        cls: "as-wizard-desc",
      });
      // Auto-select pull for empty vault
      this.syncStrategy = "pull";
    } else {
      body.createEl("p", {
        text: `This vault has ${vaultFiles.length} ${fileWord}. How should it sync with the server?`,
        cls: "as-wizard-desc",
      });
    }

    // Strategy cards
    const cards = body.createDiv("as-strategy-cards");

    const strategies: Array<{ value: InitialSyncStrategy; icon: string; label: string; desc: string; recommended: boolean }> = [
      {
        value: "pull",
        icon: "download",
        label: "Pull from server",
        desc: "Download everything from the server. Local-only files will be deleted.",
        recommended: isEmpty,
      },
      {
        value: "merge",
        icon: "git-merge",
        label: "Merge",
        desc: "Keep the newest version of each file. Both vaults are combined.",
        recommended: !isEmpty,
      },
      {
        value: "push",
        icon: "upload",
        label: "Push to server",
        desc: "Upload this vault to the server. Server-only files will be removed.",
        recommended: false,
      },
    ];

    if (isEmpty) {
      // Only show Pull for empty vault — no choice needed
      this.syncStrategy = "pull";
    } else {
      for (const s of strategies) {
        const card = cards.createDiv("as-strategy-card");
        if (s.value === this.syncStrategy) card.addClass("selected");

        const cardHeader = card.createDiv("as-strategy-card-header");
        const iconEl = cardHeader.createSpan("as-strategy-icon");
        setIcon(iconEl, s.icon);
        cardHeader.createSpan({ text: s.label, cls: "as-strategy-label" });
        if (s.recommended) {
          cardHeader.createSpan({ text: "Recommended", cls: "as-strategy-badge" });
        }

        card.createDiv({ text: s.desc, cls: "as-strategy-desc" });

        card.addEventListener("click", () => {
          this.syncStrategy = s.value;
          cards.querySelectorAll(".as-strategy-card").forEach((el) => el.removeClass("selected"));
          card.addClass("selected");
        });
      }
    }

    // What to sync toggles
    const toggleSection = body.createDiv("as-wizard-toggles");
    toggleSection.createDiv({ text: "What to sync", cls: "as-wizard-toggles-title" });

    this.addSyncToggle(toggleSection, "Sync plugins", "Sync installed plugins (.obsidian/plugins/)", this.syncPlugins, (v) => { this.syncPlugins = v; });
    this.addSyncToggle(toggleSection, "Sync settings", "Sync Obsidian settings (appearance, hotkeys, etc.)", this.syncSettings, (v) => { this.syncSettings = v; });
    this.addSyncToggle(toggleSection, "Sync workspace", "Sync workspace layout and open files", this.syncWorkspace, (v) => { this.syncWorkspace = v; });
  }

  private addSyncToggle(
    parent: HTMLElement,
    label: string,
    desc: string,
    initial: boolean,
    onChange: (v: boolean) => void
  ): void {
    const row = parent.createDiv("as-toggle-row");

    const info = row.createDiv("as-toggle-row-info");
    info.createSpan({ text: label, cls: "as-toggle-row-label" });
    info.createSpan({ text: desc, cls: "as-toggle-row-desc" });

    const toggleLabel = row.createEl("label", { cls: "as-toggle-switch" });
    const checkbox = toggleLabel.createEl("input", { type: "checkbox" });
    checkbox.checked = initial;
    toggleLabel.createSpan({ cls: "as-toggle-track" });
    checkbox.addEventListener("change", () => onChange(checkbox.checked));
  }

  private renderSummary(body: HTMLElement): void {
    body.createEl("h3", { text: "Ready to Sync" });
    body.createEl("p", { text: "Review your settings and start syncing.", cls: "as-wizard-desc" });

    const strategyLabels: Record<InitialSyncStrategy, string> = {
      pull: "Pull from server",
      merge: "Merge (newest wins)",
      push: "Push to server",
    };

    const summary = body.createDiv("as-summary");
    this.addSummaryRow(summary, "Server", this.serverUrl);
    this.addSummaryRow(summary, "Device", this.deviceName);
    this.addSummaryRow(summary, "Initial sync", strategyLabels[this.syncStrategy]);
    this.addSummaryRow(summary, "Sync plugins", this.syncPlugins ? "Yes" : "No");
    this.addSummaryRow(summary, "Sync settings", this.syncSettings ? "Yes" : "No");
    this.addSummaryRow(summary, "Encryption", "AES-256-GCM / PBKDF2");

    const startBtn = body.createEl("button", { text: "Start Syncing", cls: "mod-cta as-start-btn" });
    startBtn.addEventListener("click", () => this.finish());
  }

  private addSummaryRow(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv("as-summary-row");
    row.createSpan({ text: label, cls: "as-summary-label" });
    row.createSpan({ text: value, cls: "as-summary-value" });
  }

  // ---- Navigation ----

  private async nextStep(): Promise<void> {
    this.authError = "";

    switch (this.currentStep) {
      case 1: // Find Server
        if (!this.serverUrl || !this.serverReachable) return;
        break;
      case 2: { // Server Password
        if (!this.serverPassword) return;
        this.serverPasswordHash = await sha256String(this.serverPassword);
        // Validate via temporary WS handshake
        const nextBtn = this.contentEl.querySelector(".as-wizard-nav .mod-cta") as HTMLButtonElement | null;
        if (nextBtn) { nextBtn.textContent = "Validating..."; nextBtn.addClass("as-btn-loading"); }
        const result = await this.validateServerPassword();
        if (nextBtn) { nextBtn.textContent = "Next"; nextBtn.removeClass("as-btn-loading"); }
        if (!result.ok) {
          this.authError = result.reason || "Authentication failed — check password.";
          this.renderStep();
          return;
        }
        break;
      }
      case 3: { // Encryption Password
        if (!this.encryptionPassword) {
          if (this.errorEl) { this.errorEl.textContent = "Password cannot be empty."; this.errorEl.style.display = "block"; }
          return;
        }
        const confirmInput = (this as any)._confirmInput as HTMLInputElement;
        if (confirmInput && this.encryptionPassword !== confirmInput.value) {
          if (this.errorEl) { this.errorEl.textContent = "Passwords do not match."; this.errorEl.style.display = "block"; }
          return;
        }
        break;
      }
      case 4: // Device Name
        if (!this.deviceName) return;
        break;
    }
    this.currentStep++;
    this.renderStep();
  }

  /** Quick WS handshake to validate the server password. */
  private validateServerPassword(): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ ok: false, reason: "Connection timed out." });
      }, 8000);

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.serverUrl);
      } catch {
        clearTimeout(timeout);
        resolve({ ok: false, reason: "Could not connect to server." });
        return;
      }

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: MessageType.AUTH,
          clientId: "__wizard_test__",
          deviceName: "Wizard Test",
          passwordHash: this.serverPasswordHash,
          protocolVersion: PROTOCOL_VERSION,
        }));
      };

      ws.onmessage = (ev) => {
        clearTimeout(timeout);
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "{}");
          if (msg.type === MessageType.AUTH_OK) {
            ws.close();
            resolve({ ok: true });
          } else if (msg.type === MessageType.AUTH_FAIL) {
            ws.close();
            resolve({ ok: false, reason: msg.reason || "Invalid password." });
          }
        } catch {
          ws.close();
          resolve({ ok: false, reason: "Unexpected server response." });
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        resolve({ ok: false, reason: "Connection error." });
      };

      ws.onclose = () => {
        clearTimeout(timeout);
      };
    });
  }

  private finish(): void {
    const result: WizardResult = {
      settings: {
        serverUrl: this.serverUrl,
        serverPasswordHash: this.serverPasswordHash,
        deviceName: this.deviceName,
        initialSyncStrategy: this.syncStrategy,
        syncPlugins: this.syncPlugins,
        syncSettings: this.syncSettings,
        syncWorkspace: this.syncWorkspace,
      },
      encryptionPassword: this.encryptionPassword,
    };

    if (this.resolvePromise) {
      this.resolvePromise(result);
      this.resolvePromise = null;
    }
    this.close();
  }

  private getDefaultDeviceName(): string {
    try { return require("os").hostname(); }
    catch { return "Obsidian Device"; }
  }
}

/**
 * Simple password prompt modal for reconnecting.
 */
export class PasswordPromptModal extends Modal {
  private resolvePromise: ((password: string | null) => void) | null = null;

  static prompt(app: App): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new PasswordPromptModal(app);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("as-password-prompt");

    const title = contentEl.createDiv("as-wizard-title");
    setIcon(title.createSpan("as-wizard-icon"), "lock");
    title.createSpan({ text: "Encryption Password" });

    contentEl.createEl("p", { text: "Enter your encryption password to connect.", cls: "as-wizard-desc" });

    const group = contentEl.createDiv("as-field-group");
    const wrapper = group.createDiv("as-password-wrapper");
    const input = wrapper.createEl("input", { type: "password", placeholder: "Encryption password", cls: "as-input as-password-input" });

    const toggle = wrapper.createDiv("as-eye-toggle");
    setIcon(toggle, "eye");
    toggle.addEventListener("click", () => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      toggle.empty(); setIcon(toggle, hidden ? "eye-off" : "eye");
    });

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    const buttons = contentEl.createDiv("as-wizard-nav");
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => { this.resolvePromise?.(null); this.resolvePromise = null; this.close(); });

    const submitBtn = buttons.createEl("button", { text: "Connect", cls: "mod-cta" });
    const submit = () => {
      const pw = input.value;
      if (!pw) return;
      this.resolvePromise?.(pw);
      this.resolvePromise = null;
      this.close();
    };
    submitBtn.addEventListener("click", submit);
    setTimeout(() => input.focus(), 50);
  }

  onClose(): void {
    if (this.resolvePromise) { this.resolvePromise(null); this.resolvePromise = null; }
    this.contentEl.empty();
  }
}
