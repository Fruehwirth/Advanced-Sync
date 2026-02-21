/**
 * File watcher: Monitors vault events and emits debounced change events.
 * Includes a suppress set to prevent feedback loops during sync writes.
 */

import type { Vault, TAbstractFile, EventRef } from "obsidian";
import type { AdvancedSyncSettings } from "../types";

export interface FileChange {
  type: "create" | "modify" | "delete" | "rename";
  path: string;
  oldPath?: string;
}

export type FileChangeCallback = (change: FileChange) => void;

export class FileWatcher {
  private vault: Vault;
  private settings: AdvancedSyncSettings;
  private callback: FileChangeCallback;
  private eventRefs: EventRef[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private suppressedPaths: Set<string> = new Set();
  private debounceMs = 300;
  /** Periodic poll interval for .obsidian/ files (mobile compatibility). */
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** Cached mtimes for adapter-level files from last poll. */
  private adapterMtimes: Map<string, number> = new Map();

  constructor(
    vault: Vault,
    settings: AdvancedSyncSettings,
    callback: FileChangeCallback
  ) {
    this.vault = vault;
    this.settings = settings;
    this.callback = callback;
  }

  start(): void {
    this.eventRefs.push(
      this.vault.on("modify", (file) => {
        this.handleEvent("modify", file);
      })
    );

    this.eventRefs.push(
      this.vault.on("create", (file) => {
        this.handleEvent("create", file);
      })
    );

    this.eventRefs.push(
      this.vault.on("delete", (file) => {
        this.handleEvent("delete", file);
      })
    );

    this.eventRefs.push(
      this.vault.on("rename", (file, oldPath) => {
        this.handleEvent("rename", file, oldPath);
      })
    );

    // Start periodic polling for .obsidian/ files (vault events don't fire for these on mobile)
    this.startAdapterPoll();
  }

  stop(): void {
    for (const ref of this.eventRefs) {
      this.vault.offref(ref);
    }
    this.eventRefs = [];

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.adapterMtimes.clear();
  }

  /**
   * Suppress a path from triggering change events.
   * Used when the sync engine writes files to prevent feedback loops.
   */
  suppress(path: string): void {
    this.suppressedPaths.add(path);
  }

  /**
   * Remove path from suppression after sync write completes.
   */
  unsuppress(path: string): void {
    this.suppressedPaths.delete(path);
  }

  private handleEvent(
    type: "create" | "modify" | "delete" | "rename",
    file: TAbstractFile,
    oldPath?: string
  ): void {
    const filePath = file.path;

    // Check suppression
    if (this.suppressedPaths.has(filePath)) {
      this.suppressedPaths.delete(filePath);
      return;
    }

    // Filter excluded patterns
    if (this.shouldExclude(filePath)) {
      return;
    }

    // Debounce: cancel any pending event for this path
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);

      const change: FileChange = { type, path: filePath };
      if (type === "rename" && oldPath) {
        change.oldPath = oldPath;
      }
      this.callback(change);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /** Check if a path should be excluded from sync. */
  shouldExclude(filePath: string): boolean {
    // Always exclude the plugin's own directory
    if (
      filePath.startsWith(".obsidian/plugins/advanced-sync/") ||
      filePath === ".obsidian/plugins/advanced-sync"
    ) {
      return true;
    }

    // Optionally exclude workspace files
    if (!this.settings.syncWorkspace) {
      if (
        filePath === ".obsidian/workspace.json" ||
        filePath === ".obsidian/workspace-mobile.json"
      ) {
        return true;
      }
    }

    // Skip plugins if setting is off
    if (!this.settings.syncPlugins && filePath.startsWith(".obsidian/plugins/")) {
      return true;
    }

    // Skip settings if setting is off
    if (
      !this.settings.syncSettings &&
      filePath.startsWith(".obsidian/") &&
      !filePath.startsWith(".obsidian/plugins/")
    ) {
      return true;
    }

    // Check user exclude patterns
    for (const pattern of this.settings.excludePatterns) {
      if (this.matchPattern(filePath, pattern)) {
        return true;
      }
    }

    return false;
  }

  /** Simple glob pattern matching (supports * and **). */
  private matchPattern(filePath: string, pattern: string): boolean {
    // Convert glob to regex
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "{{DOUBLE}}")
      .replace(/\*/g, "[^/]*")
      .replace(/{{DOUBLE}}/g, ".*");
    return new RegExp("^" + regex + "$").test(filePath);
  }

  /** Start periodic polling for .obsidian/ file changes via adapter. */
  private startAdapterPoll(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => this.pollAdapterFiles(), 5000);
  }

  /** Poll .obsidian/plugins/ (and settings) for mtime changes. */
  private async pollAdapterFiles(): Promise<void> {
    const adapter = this.vault.adapter;
    const dirsToScan: string[] = [];

    if (this.settings.syncPlugins) dirsToScan.push(".obsidian/plugins");
    if (this.settings.syncSettings) dirsToScan.push(".obsidian");

    const currentFiles = new Map<string, number>();

    for (const dir of dirsToScan) {
      await this.pollDir(adapter, dir, currentFiles, dir === ".obsidian");
    }

    // Detect new or modified files
    for (const [path, mtime] of currentFiles) {
      const prev = this.adapterMtimes.get(path);
      if (prev === undefined) {
        // First time seeing this file — only emit if we had a previous scan
        if (this.adapterMtimes.size > 0) {
          this.emitAdapterChange("create", path);
        }
      } else if (mtime > prev) {
        this.emitAdapterChange("modify", path);
      }
    }

    // Detect deleted files
    for (const [path] of this.adapterMtimes) {
      if (!currentFiles.has(path)) {
        this.emitAdapterChange("delete", path);
      }
    }

    this.adapterMtimes = currentFiles;
  }

  /** Recursively scan a directory and collect file paths + mtimes. */
  private async pollDir(
    adapter: any,
    dir: string,
    out: Map<string, number>,
    topLevelOnly = false
  ): Promise<void> {
    try {
      const listing = await adapter.list(dir);

      for (const filePath of listing.files) {
        // When scanning .obsidian top-level, skip plugins/ (handled separately)
        if (topLevelOnly && filePath.startsWith(".obsidian/plugins/")) continue;
        if (this.shouldExclude(filePath)) continue;

        const stat = await adapter.stat(filePath);
        if (stat && stat.type === "file") {
          out.set(filePath, stat.mtime);
        }
      }

      if (!topLevelOnly) {
        for (const subdir of listing.folders) {
          await this.pollDir(adapter, subdir, out);
        }
      }
    } catch {
      // Directory may not exist
    }
  }

  /** Emit a change from adapter polling (with suppression check). */
  private emitAdapterChange(type: "create" | "modify" | "delete", path: string): void {
    if (this.suppressedPaths.has(path)) {
      this.suppressedPaths.delete(path);
      return;
    }
    this.callback({ type, path });
  }
}
