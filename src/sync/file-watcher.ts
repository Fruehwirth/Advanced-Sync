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
  /** True after the first adapter poll completes — guards against emitting
   *  spurious "create" events on startup for files that already existed. */
  private adapterPollHasRun = false;
  /** Guard against double event registration. */
  private running = false;

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
    if (this.running) return;
    this.running = true;
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
    this.running = false;
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
    this.adapterPollHasRun = false;
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

    // Check suppression — do NOT delete here; unsuppress() clears after the write window.
    // This prevents Obsidian's double-fire (create + modify for a single write) from leaking.
    if (this.suppressedPaths.has(filePath)) {
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

    // If not syncing all file types, only allow .md files (plus .obsidian/ handled above)
    if (!this.settings.syncAllFileTypes && !filePath.startsWith(".obsidian/")) {
      const ext = filePath.split(".").pop()?.toLowerCase();
      if (ext !== "md") return true;
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
    const currentFiles = new Map<string, number>();

    // Scan .obsidian/ recursively (icons/, snippets/, themes/, etc.)
    // but skip plugins/ — it is handled separately by the syncPlugins path.
    if (this.settings.syncSettings) {
      await this.pollDir(adapter, ".obsidian", currentFiles, ".obsidian/plugins");
    }

    // Scan .obsidian/plugins/ separately (may be off independently)
    if (this.settings.syncPlugins) {
      await this.pollDir(adapter, ".obsidian/plugins", currentFiles);
    }

    if (!this.adapterPollHasRun) {
      // First run: just establish the baseline — never emit on startup.
      // Also seed the map with any mtime already set by setCachedMtime.
      for (const [path, diskMtime] of currentFiles) {
        const cached = this.adapterMtimes.get(path) ?? 0;
        this.adapterMtimes.set(path, Math.max(diskMtime, cached));
      }
      this.adapterPollHasRun = true;
      return;
    }

    // Detect new or modified files
    for (const [path, diskMtime] of currentFiles) {
      const prev = this.adapterMtimes.get(path);
      if (prev === undefined) {
        this.emitAdapterChange("create", path);
      } else if (diskMtime > prev) {
        this.emitAdapterChange("modify", path);
      }
    }

    // Detect deleted files
    for (const [path] of this.adapterMtimes) {
      if (!currentFiles.has(path)) {
        this.emitAdapterChange("delete", path);
      }
    }

    // Update adapterMtimes in-place using Math.max so that any setCachedMtime()
    // call that happened concurrently (during an await in pollDir) is never
    // overwritten by a stale disk value read before the write completed.
    for (const [path, diskMtime] of currentFiles) {
      const cached = this.adapterMtimes.get(path) ?? 0;
      this.adapterMtimes.set(path, Math.max(diskMtime, cached));
    }
    for (const path of [...this.adapterMtimes.keys()]) {
      if (!currentFiles.has(path)) this.adapterMtimes.delete(path);
    }
  }

  /** Recursively scan a directory and collect file paths + mtimes.
   *  @param skipSubdirPrefix — skip any subdirectory whose path starts with this string. */
  private async pollDir(
    adapter: any,
    dir: string,
    out: Map<string, number>,
    skipSubdirPrefix?: string
  ): Promise<void> {
    try {
      const listing = await adapter.list(dir);

      for (const filePath of listing.files) {
        if (this.shouldExclude(filePath)) continue;
        const stat = await adapter.stat(filePath);
        if (stat && stat.type === "file") out.set(filePath, stat.mtime);
      }

      for (const subdir of listing.folders) {
        if (skipSubdirPrefix && subdir.startsWith(skipSubdirPrefix)) continue;
        await this.pollDir(adapter, subdir, out, skipSubdirPrefix);
      }
    } catch {
      // Directory may not exist
    }
  }

  /**
   * Pre-populate the adapter mtime cache for a path that was just written by the
   * sync engine. Prevents the 5-second poll from treating sync writes as user edits.
   */
  setCachedMtime(path: string, mtime: number): void {
    this.adapterMtimes.set(path, mtime);
  }

  /** Emit a change from adapter polling (with suppression check). */
  private emitAdapterChange(type: "create" | "modify" | "delete", path: string): void {
    // Same non-one-shot suppression as vault events
    if (this.suppressedPaths.has(path)) {
      return;
    }
    this.callback({ type, path });
  }
}
