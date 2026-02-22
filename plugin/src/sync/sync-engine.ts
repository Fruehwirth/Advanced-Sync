/**
 * Sync engine: Orchestrates full sync + incremental sync.
 * State machine: DISCONNECTED → CONNECTING → AUTHENTICATING → SYNCING → IDLE
 */

import { Notice } from "obsidian";
import type { App, Vault, DataAdapter } from "obsidian";
import { MessageType } from "@vault-sync/shared/protocol";
import type {
  SyncResponseMessage,
  FileChangedMessage,
  FileRemovedMessage,
  FileDownloadResponseMessage,
  FileUploadAckMessage,
} from "@vault-sync/shared/protocol";
import type { EncryptedFileEntry, SyncState } from "@vault-sync/shared/types";
import { encryptBlob, decryptBlob, encryptMetadata, decryptMetadata, sha256Hex } from "../crypto/encryption";
import { deriveVaultKey, deriveFileId, saltFromBase64 } from "../crypto/key-management";
import { resolveConflict } from "./conflict-resolver";
import { FileWatcher } from "./file-watcher";
import type { FileChange } from "./file-watcher";
import { ConnectionManager } from "../network/connection";
import type { AdvancedSyncSettings } from "../types";

/** A record of a single synced file change, shown in the status popup. */
export interface SyncHistoryEntry {
  path: string;
  filename: string;
  direction: "upload" | "download" | "delete" | "connect" | "disconnect" | "error";
  timestamp: number;
  /** How many consecutive times this same file+direction was recorded. */
  count: number;
}

const MAX_HISTORY = 50;

/** Decrypted file metadata stored locally for sync comparison. */
interface LocalFileInfo {
  path: string;
  fileId: string;
  mtime: number;
  size: number;
  contentHash: string;
}

export type SyncStateCallback = (state: SyncState, detail?: string) => void;
export type SyncProgressCallback = (current: number, total: number, detail: string) => void;

export class SyncEngine {
  private app: App;
  private settings: AdvancedSyncSettings;
  private connection: ConnectionManager;
  private fileWatcher: FileWatcher;
  private vaultKey: CryptoKey | null = null;
  private localManifest: Map<string, LocalFileInfo> = new Map();
  private pendingDownloads: Map<string, FileDownloadResponseMessage> = new Map();
  private pluginFilesChanged = false;
  private saveSettings: () => Promise<void>;
  /** True once the initial sync completes and we are ready for incremental changes. */
  private readyForIncrementalSync = false;
  /**
   * Downloads still in flight during the initial full sync.
   * readyForIncrementalSync is deferred until this reaches zero so no
   * vault event or adapter-poll tick can re-upload a file while it is
   * still being written to disk.
   */
  private pendingInitialDownloads = 0;
  private totalInitialDownloads = 0;
  /** Sequence number held until all downloads finish before persisting. */
  private pendingSequence: number | null = null;
  /** When true, force sync uses pull-from-server strategy. */
  private _forcePull = false;
  /** Count of downloads that failed during the current sync batch. */
  private failedDownloads = 0;
  /** The actual current state, including "idle" which ConnectionManager never emits. */
  private _state: SyncState = "disconnected";
  /** Rolling log of recently synced file changes (newest first). */
  readonly history: SyncHistoryEntry[] = [];

  onStateChange: SyncStateCallback = () => {};
  onProgress: SyncProgressCallback = () => {};
  /** Called whenever the history array is updated (file synced, connected, etc.). */
  onHistoryChange: () => void = () => {};

  constructor(
    app: App,
    settings: AdvancedSyncSettings,
    saveSettings: () => Promise<void>
  ) {
    this.app = app;
    this.settings = settings;
    this.saveSettings = saveSettings;

    this.connection = new ConnectionManager(settings);
    this.fileWatcher = new FileWatcher(
      app.vault,
      settings,
      (change) => this.handleLocalChange(change)
    );

    this.setupConnectionCallbacks();
  }

  get state(): SyncState {
    return this._state;
  }

  /** Start sync: connect to server and begin watching files. */
  async connect(encryptionPassword: string): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.serverPasswordHash) {
      return;
    }

    // If we already have a vault salt, derive the key now
    if (this.settings.vaultSalt) {
      this.vaultKey = await deriveVaultKey(
        encryptionPassword,
        saltFromBase64(this.settings.vaultSalt)
      );
    }

    // Store password temporarily for key derivation after receiving salt
    (this as any)._tempPassword = encryptionPassword;

    this.connection.connect();
    this.fileWatcher.start();
  }

  /** Disconnect and stop watching. */
  disconnect(): void {
    this.readyForIncrementalSync = false;
    this.pendingInitialDownloads = 0;
    this.totalInitialDownloads = 0;
    this.pendingSequence = null;
    this._forcePull = false;
    this.failedDownloads = 0;
    this._state = "disconnected";
    this.fileWatcher.stop();
    this.connection.disconnect();
    this.vaultKey = null;
    this.localManifest.clear();
    this.pendingDownloads.clear();
    delete (this as any)._tempPassword;
  }

  /** Force a full resync. Rebuilds the local manifest first so newly added or
   *  previously-missed files (e.g. .obsidian/icons/) are included. */
  async forceSync(): Promise<void> {
    if (this.connection.isConnected) {
      this.readyForIncrementalSync = false;
      this._forcePull = true;
      this.settings.lastSequence = 0;
      await this.saveSettings();
      // Rebuild manifest — picks up any files that were missed by a previous
      // (pre-fix) manifest build, e.g. .obsidian/icons/, .obsidian/snippets/
      await this.buildLocalManifest();
      this.connection.requestSync(0);
    }
  }

  private setupConnectionCallbacks(): void {
    this.connection.onStateChange = (state, error) => {
      if (state === "idle") {
        // Record "connected" only on the first idle transition (initial sync done)
        if (!this.readyForIncrementalSync) {
          this.recordHistory("Server", "connect");
        }
      } else if (state === "disconnected") {
        if (this.readyForIncrementalSync) {
          this.recordHistory("Server", "disconnect");
        }
      } else if (state === "error" && error) {
        this.recordHistory(error, "error");
      }
      this._state = state;
      this.onStateChange(state, error);
    };

    this.connection.onVaultSalt = async (salt, serverId) => {
      this.settings.vaultSalt = salt;
      this.settings.serverId = serverId;
      await this.saveSettings();

      // Derive vault key if we have the password
      const tempPassword = (this as any)._tempPassword;
      if (tempPassword && !this.vaultKey) {
        this.vaultKey = await deriveVaultKey(
          tempPassword,
          saltFromBase64(salt)
        );
      }
      delete (this as any)._tempPassword;

      // Build local manifest and request sync
      await this.buildLocalManifest();
      this.connection.requestSync(this.settings.lastSequence);
    };

    this.connection.onSyncResponse = async (msg) => {
      await this.handleSyncResponse(msg);
    };

    this.connection.onFileChanged = async (msg) => {
      await this.handleRemoteFileChanged(msg);
    };

    this.connection.onFileRemoved = async (msg) => {
      await this.handleRemoteFileRemoved(msg);
    };

    this.connection.onFileDownload = (msg) => {
      // Store the metadata; binary data arrives next
      this.pendingDownloads.set(msg.fileId, msg);
    };

    this.connection.onBinaryData = async (data) => {
      await this.handleBinaryDownload(data);
    };

    this.connection.onFileUploadAck = (msg) => {
      this.handleUploadAck(msg);
    };
  }

  /** Build a manifest of all local files for sync comparison. */
  private async buildLocalManifest(): Promise<void> {
    if (!this.vaultKey) return;

    this.localManifest.clear();
    const files = this.app.vault.getFiles();

    for (const file of files) {
      if (this.fileWatcher.shouldExclude(file.path)) continue;

      const fileId = await deriveFileId(file.path, this.vaultKey);
      this.localManifest.set(fileId, {
        path: file.path,
        fileId,
        mtime: file.stat.mtime,
        size: file.stat.size,
        contentHash: "", // Computed on demand
      });
    }

    // Scan .obsidian/ files using adapter (vault.getFiles() doesn't include them)
    await this.scanAdapterFiles();
  }

  /** Scan .obsidian/ files via adapter.list() for plugin & settings sync. */
  private async scanAdapterFiles(): Promise<void> {
    if (!this.vaultKey) return;
    const adapter = this.app.vault.adapter;

    // Scan plugin files
    if (this.settings.syncPlugins) {
      await this.scanAdapterDir(adapter, ".obsidian/plugins");
    }

    // Scan .obsidian/ settings — top-level files AND all subdirectories
    // (e.g. icons/, snippets/, themes/) but NOT plugins/ (handled above).
    if (this.settings.syncSettings) {
      try {
        const listing = await adapter.list(".obsidian");

        // Top-level files (.obsidian/*.json, .obsidian/*.css, etc.)
        for (const filePath of listing.files) {
          if (filePath.startsWith(".obsidian/plugins/")) continue;
          if (this.fileWatcher.shouldExclude(filePath)) continue;
          if (this.localManifest.has(await deriveFileId(filePath, this.vaultKey!))) continue;

          const stat = await adapter.stat(filePath);
          if (!stat || stat.type !== "file") continue;

          const fileId = await deriveFileId(filePath, this.vaultKey!);
          this.localManifest.set(fileId, {
            path: filePath, fileId, mtime: stat.mtime, size: stat.size, contentHash: "",
          });
        }

        // Subdirectories — recurse into everything except plugins/
        for (const subdir of listing.folders) {
          if (subdir.startsWith(".obsidian/plugins")) continue;
          await this.scanAdapterDir(adapter, subdir);
        }
      } catch {
        // .obsidian dir may not exist yet
      }
    }
  }

  /** Recursively scan a directory via adapter.list() and add files to manifest. */
  private async scanAdapterDir(adapter: DataAdapter, dir: string): Promise<void> {
    if (!this.vaultKey) return;

    try {
      const listing = await adapter.list(dir);

      for (const filePath of listing.files) {
        if (this.fileWatcher.shouldExclude(filePath)) continue;

        // Check if already in manifest (from vault.getFiles())
        const fileId = await deriveFileId(filePath, this.vaultKey!);
        if (this.localManifest.has(fileId)) continue;

        const stat = await adapter.stat(filePath);
        if (!stat || stat.type !== "file") continue;

        this.localManifest.set(fileId, {
          path: filePath,
          fileId,
          mtime: stat.mtime,
          size: stat.size,
          contentHash: "",
        });
      }

      // Recurse into subdirectories
      for (const subdir of listing.folders) {
        await this.scanAdapterDir(adapter, subdir);
      }
    } catch {
      // Directory may not exist
    }
  }

  /** Handle sync response from server (full or incremental). */
  private async handleSyncResponse(msg: SyncResponseMessage): Promise<void> {
    if (!this.vaultKey) return;

    const toDownload: EncryptedFileEntry[] = [];
    const toUpload: LocalFileInfo[] = [];
    const toDelete: string[] = []; // local files to delete

    // Build set of server file IDs
    const serverFiles = new Map<string, EncryptedFileEntry>();
    for (const entry of msg.entries) {
      serverFiles.set(entry.fileId, entry);
    }

    if (msg.fullSync) {
      // Force pull: download everything from server, delete local-only, upload nothing
      if (this._forcePull) {
        this._forcePull = false;
        for (const [, entry] of serverFiles) {
          if (!entry.deleted) toDownload.push(entry);
        }
        for (const [fileId, local] of this.localManifest) {
          if (!serverFiles.has(fileId)) toDelete.push(local.path);
        }
      } else {
        // Read the strategy for initial sync; always reset to "merge" after use
        // so that reconnects use the normal incremental path.
        const strategy = this.settings.initialSyncStrategy ?? "merge";
        this.settings.initialSyncStrategy = "merge";
        await this.saveSettings();

        if (strategy === "pull") {
          // Pull: download everything from server, delete local-only files
          for (const [, entry] of serverFiles) {
            if (!entry.deleted) toDownload.push(entry);
          }
          // Local files not on server → delete locally
          for (const [fileId, local] of this.localManifest) {
            if (!serverFiles.has(fileId)) toDelete.push(local.path);
          }

        } else if (strategy === "push") {
          // Push: upload everything local, delete server-only files
          for (const [, local] of this.localManifest) {
            toUpload.push(local);
          }
          // Server files not local → delete from server
          for (const [fileId] of serverFiles) {
            if (!this.localManifest.has(fileId)) {
              this.connection.send({ type: MessageType.FILE_DELETE, fileId });
            }
          }

        } else {
          // Merge (default): newest file wins for regular vault files.
          //
          // IMPORTANT: .obsidian/ config files are always taken from the server during
          // initial sync. A freshly-set-up device only has Obsidian's installation
          // defaults (e.g. community-plugins.json listing only 2 plugins). Those
          // defaults have a current timestamp, which would "win" a timestamp comparison
          // against the server's real config and overwrite it on all other devices.
          // During subsequent incremental syncs the normal conflict logic applies.

          for (const [fileId, entry] of serverFiles) {
            if (entry.deleted) continue;
            const local = this.localManifest.get(fileId);
            if (!local) {
              // File is on server but not local → always download
              toDownload.push(entry);
            } else if (local.path.startsWith(".obsidian/")) {
              // .obsidian/ file exists on both: server always wins during initial sync
              toDownload.push(entry);
            } else {
              // Regular vault file: newest timestamp wins
              const winner = resolveConflict(local.mtime, entry.mtime);
              if (winner === "remote") toDownload.push(entry);
              else toUpload.push(local);
            }
          }

          // Local-only files
          for (const [fileId, local] of this.localManifest) {
            if (!serverFiles.has(fileId)) {
              if (local.path.startsWith(".obsidian/")) {
                // Local-only .obsidian/ file on a new device: this device has a config
                // the server doesn't know about. Do NOT push it — the server's state is
                // canonical. (If the user wants to push local config, use Push strategy.)
                continue;
              }
              toUpload.push(local);
            }
          }
        }
      }

    } else {
      // Incremental sync: process changes from server
      for (const entry of msg.entries) {
        if (entry.deleted) {
          const local = this.localManifest.get(entry.fileId);
          if (local) toDelete.push(local.path);
        } else {
          const local = this.localManifest.get(entry.fileId);
          if (!local || resolveConflict(local.mtime, entry.mtime) === "remote") {
            toDownload.push(entry);
          }
        }
      }
    }

    const total = toDownload.length + toUpload.length + toDelete.length;
    let current = 0;

    if (total === 0) {
      this.settings.lastSequence = msg.currentSequence;
      await this.saveSettings();
      this.readyForIncrementalSync = true;
      this._state = "idle";
      this.onStateChange("idle", "Up to date");
      return;
    }

    // Defer sequence persistence until all downloads complete.
    // If we saved now and the connection drops mid-download, the server
    // would do an incremental sync on reconnect and skip all missed files.
    this.pendingSequence = msg.currentSequence;

    // Process uploads first (await each — uploads are sequential and safe)
    for (let i = 0; i < toUpload.length; i++) {
      const local = toUpload[i];
      current++;
      const label = local.path.split("/").pop() ?? local.path;
      this.onProgress(current, total, `Uploading ${i + 1}/${toUpload.length}: ${label}`);
      await this.uploadFile(local.path);
    }

    // Process deletes (await each)
    for (let i = 0; i < toDelete.length; i++) {
      current++;
      const label = toDelete[i].split("/").pop() ?? toDelete[i];
      this.onProgress(current, total, `Deleting ${i + 1}/${toDelete.length}: ${label}`);
      await this.deleteLocalFile(toDelete[i]);
    }

    if (toDownload.length === 0) {
      // No downloads — persist sequence and transition to idle immediately
      this.settings.lastSequence = this.pendingSequence!;
      this.pendingSequence = null;
      await this.saveSettings();
      this.readyForIncrementalSync = true;
      this._state = "idle";
      this.onStateChange("idle", "Synced");
      return;
    }

    // Request all downloads. The server pushes FILE_DOWNLOAD_RESPONSE (text)
    // + binary frame pairs. readyForIncrementalSync stays false until the
    // last binary has been written so nothing can re-upload mid-write.
    this.totalInitialDownloads = toDownload.length;
    this.pendingInitialDownloads = toDownload.length;
    this.failedDownloads = 0;
    this.onProgress(0, toDownload.length, `Downloading 0 / ${toDownload.length} files`);

    for (const entry of toDownload) {
      this.connection.send({ type: MessageType.FILE_DOWNLOAD, fileId: entry.fileId });
    }
  }

  /** Record a file change in the history log.
   *  Searches within the last 5 entries for a matching path+direction so that
   *  intermediate background writes (e.g. vault-stats.json) don't prevent
   *  consecutive edits to the same file from being counted up. */
  private recordHistory(path: string, direction: SyncHistoryEntry["direction"]): void {
    const LOOK_BACK = 5;
    for (let i = 0; i < Math.min(LOOK_BACK, this.history.length); i++) {
      const entry = this.history[i];
      if (entry.path === path && entry.direction === direction) {
        entry.count++;
        entry.timestamp = Date.now();
        // Bring the matched entry to the top so it stays visible
        if (i > 0) {
          this.history.splice(i, 1);
          this.history.unshift(entry);
        }
        this.onHistoryChange();
        return;
      }
    }
    this.history.unshift({
      path,
      filename: path.split("/").pop() ?? path,
      direction,
      timestamp: Date.now(),
      count: 1,
    });
    if (this.history.length > MAX_HISTORY) this.history.pop();
    this.onHistoryChange();
  }

  /** Upload a local file to the server. */
  private async uploadFile(filePath: string): Promise<void> {
    if (!this.vaultKey) return;

    try {
      // Read file content using adapter for .obsidian files
      let content: ArrayBuffer;
      if (filePath.startsWith(".obsidian/")) {
        const data = await this.app.vault.adapter.readBinary(filePath);
        content = data;
      } else {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !("stat" in file)) return;
        content = await this.app.vault.readBinary(file as any);
      }

      const fileId = await deriveFileId(filePath, this.vaultKey);
      const encrypted = await encryptBlob(content, this.vaultKey);
      const encryptedMeta = await encryptMetadata(
        { path: filePath },
        this.vaultKey
      );

      const stat = await this.app.vault.adapter.stat(filePath);
      const mtime = stat?.mtime ?? Date.now();
      const size = stat?.size ?? content.byteLength;

      // Send upload header (text frame)
      this.connection.send({
        type: MessageType.FILE_UPLOAD,
        fileId,
        encryptedMeta,
        mtime,
        size,
      });

      // Send encrypted blob (binary frame)
      const blobStr = JSON.stringify(encrypted);
      const blobData = new TextEncoder().encode(blobStr);
      this.connection.sendBinary(blobData.buffer);

      this.recordHistory(filePath, "upload");

      // Update local manifest
      this.localManifest.set(fileId, {
        path: filePath,
        fileId,
        mtime,
        size,
        contentHash: "",
      });
    } catch (err: any) {
      console.error(`[Sync] Failed to upload ${filePath}:`, err.message);
    }
  }

  /** Handle incoming binary data (file download). */
  private async handleBinaryDownload(data: ArrayBuffer): Promise<void> {
    if (!this.vaultKey) return;

    // Find the pending download this binary data belongs to
    // (downloads are processed in order, so take the first pending)
    let entry: FileDownloadResponseMessage | undefined;
    let downloadFileId: string | undefined;

    for (const [fileId, msg] of this.pendingDownloads) {
      entry = msg;
      downloadFileId = fileId;
      break;
    }

    if (!entry || !downloadFileId) return;
    this.pendingDownloads.delete(downloadFileId);

    let failed = false;
    let filePath: string | undefined;
    try {
      // Decrypt metadata to get the file path
      const meta = await decryptMetadata<{ path: string }>(
        entry.encryptedMeta,
        this.vaultKey
      );
      if (!meta) {
        console.error("[Sync] Failed to decrypt metadata for", downloadFileId);
        failed = true;
        return;
      }
      filePath = meta.path;

      // Decrypt the blob
      const blobStr = new TextDecoder().decode(data);
      const encrypted = JSON.parse(blobStr);
      const decrypted = await decryptBlob(encrypted, this.vaultKey);
      if (!decrypted) {
        console.error("[Sync] Failed to decrypt blob for", filePath);
        failed = true;
        return;
      }

      // Respect syncPlugins / syncSettings toggles for incoming files too
      if (this.fileWatcher.shouldExclude(filePath)) {
        return;
      }

      // Write file to vault
      await this.writeFile(filePath, decrypted, entry.mtime);
      this.recordHistory(filePath, "download");

      // Update local manifest
      this.localManifest.set(downloadFileId, {
        path: filePath,
        fileId: downloadFileId,
        mtime: entry.mtime,
        size: entry.size,
        contentHash: "",
      });

      // Check if this is a plugin file
      if (filePath.startsWith(".obsidian/plugins/")) {
        this.pluginFilesChanged = true;
      }
    } catch (err: any) {
      console.error("[Sync] Error processing download:", err.message);
      failed = true;
    } finally {
      if (failed) {
        this.failedDownloads++;
        // Use decrypted path when available, fall back to fileId
        this.recordHistory(filePath ?? downloadFileId!, "error");
      }

      // Count down initial-sync downloads. Flip readyForIncrementalSync only
      // when the very last file has been written so nothing can re-upload it.
      if (this.pendingInitialDownloads > 0) {
        this.pendingInitialDownloads--;
        const received = this.totalInitialDownloads - this.pendingInitialDownloads;
        this.onProgress(
          received,
          this.totalInitialDownloads,
          `Downloading ${received} / ${this.totalInitialDownloads} files`
        );

        if (this.pendingInitialDownloads === 0) {
          this.totalInitialDownloads = 0;

          // Persist the deferred sequence now that all downloads are done
          if (this.pendingSequence !== null) {
            this.settings.lastSequence = this.pendingSequence;
            this.pendingSequence = null;
            this.saveSettings();
          }

          // Notify user about failed downloads
          if (this.failedDownloads > 0) {
            new Notice(`Sync: ${this.failedDownloads} file(s) failed to download. Check Recent Changes for details.`);
            this.failedDownloads = 0;
          }

          this.readyForIncrementalSync = true;
          this._state = "idle";
          this.onStateChange("idle", "Synced");
        }
      }
    }
  }

  /** Handle a remote file change notification (real-time from another client). */
  private async handleRemoteFileChanged(msg: FileChangedMessage): Promise<void> {
    if (msg.sourceClientId === this.settings.clientId) return;

    // Update sequence
    if (msg.sequence > this.settings.lastSequence) {
      this.settings.lastSequence = msg.sequence;
      await this.saveSettings();
    }

    // Check conflict
    const local = this.localManifest.get(msg.fileId);
    if (local) {
      const winner = resolveConflict(local.mtime, msg.mtime);
      if (winner === "local") return; // Local version is newer
    }

    // Download the changed file
    this.connection.send({
      type: MessageType.FILE_DOWNLOAD,
      fileId: msg.fileId,
    });
  }

  /** Handle a remote file removal notification. */
  private async handleRemoteFileRemoved(msg: FileRemovedMessage): Promise<void> {
    if (msg.sourceClientId === this.settings.clientId) return;

    if (msg.sequence > this.settings.lastSequence) {
      this.settings.lastSequence = msg.sequence;
      await this.saveSettings();
    }

    const local = this.localManifest.get(msg.fileId);
    if (local) {
      await this.deleteLocalFile(local.path);
      this.localManifest.delete(msg.fileId);
    }
  }

  /** Handle upload acknowledgment. */
  private handleUploadAck(msg: FileUploadAckMessage): void {
    if (msg.sequence > this.settings.lastSequence) {
      this.settings.lastSequence = msg.sequence;
      this.saveSettings();
    }
  }

  /** Handle a local file change (from file watcher). */
  private async handleLocalChange(change: FileChange): Promise<void> {
    if (!this.vaultKey || !this.readyForIncrementalSync) return;

    switch (change.type) {
      case "create":
      case "modify":
        await this.uploadFile(change.path);
        break;
      case "delete":
        await this.handleLocalDelete(change.path);
        break;
      case "rename":
        if (change.oldPath) {
          await this.handleLocalDelete(change.oldPath);
        }
        await this.uploadFile(change.path);
        break;
    }
  }

  /** Handle local file deletion — sends FILE_DELETE to server. */
  private async handleLocalDelete(filePath: string): Promise<void> {
    if (!this.vaultKey) return;

    const fileId = await deriveFileId(filePath, this.vaultKey);
    this.localManifest.delete(fileId);

    this.connection.send({
      type: MessageType.FILE_DELETE,
      fileId,
    });
  }

  /** Write a file to the vault, suppressing the file watcher. */
  private async writeFile(
    filePath: string,
    content: ArrayBuffer,
    mtime: number
  ): Promise<void> {
    this.fileWatcher.suppress(filePath);

    try {
      // Ensure parent directory exists
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dir) {
        try {
          await this.app.vault.adapter.mkdir(dir);
        } catch {
          // Directory may already exist
        }
      }

      await this.app.vault.adapter.writeBinary(filePath, content);

      // For .obsidian/ files tracked by the adapter poll: cache the real on-disk mtime
      // immediately so the next poll tick doesn't treat this sync write as a user edit.
      if (filePath.startsWith(".obsidian/")) {
        const stat = await this.app.vault.adapter.stat(filePath);
        if (stat) this.fileWatcher.setCachedMtime(filePath, stat.mtime);
      }
    } catch (err: any) {
      console.error(`[Sync] Failed to write ${filePath}:`, err.message);
    } finally {
      // Unsuppress after 1 second — long enough to cover Obsidian's double-fire
      // (create + modify) and the 300 ms debounce timer.
      setTimeout(() => this.fileWatcher.unsuppress(filePath), 1000);
    }
  }

  /** Delete a local file. */
  private async deleteLocalFile(filePath: string): Promise<void> {
    this.fileWatcher.suppress(filePath);
    try {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file) {
        await this.app.vault.delete(file);
      } else {
        // Try adapter for .obsidian files
        try {
          await this.app.vault.adapter.remove(filePath);
        } catch {
          // File may already be gone
        }
      }
      this.recordHistory(filePath, "delete");
    } catch (err: any) {
      console.error(`[Sync] Failed to delete ${filePath}:`, err.message);
    } finally {
      setTimeout(() => this.fileWatcher.unsuppress(filePath), 1000);
    }
  }

  /**
   * Call after initial sync to notify user about plugin changes.
   */
  checkPluginChanges(): void {
    // Plugin files may have changed during sync — clear the flag silently.
    // The user can see what was synced in the Recent Changes view.
    this.pluginFilesChanged = false;
  }
}
