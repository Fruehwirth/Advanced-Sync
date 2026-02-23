/**
 * Sync engine: Orchestrates full sync + incremental sync.
 * State machine: DISCONNECTED → CONNECTING → AUTHENTICATING → SYNCING → IDLE
 *
 * Protocol v2 changes:
 * - Raw binary blob format (no base64 JSON wrapping)
 * - Sync preview mode (dry-run before applying)
 * - Activity model with per-file status tracking
 * - Non-blocking batch processing (yield to event loop)
 * - Token-based auth with key persistence
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
import type { EncryptedFileEntry, SyncState, ClientSession } from "@vault-sync/shared/types";
import { encryptBlob, decryptBlob, encryptMetadata, decryptMetadata, sha256Hex, exportKey, importKey } from "../crypto/encryption";
import { deriveVaultKey, deriveFileId, saltFromBase64 } from "../crypto/key-management";
import { sha256String } from "../crypto/encryption";
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

/** Per-file activity tracking during active sync operations. */
export interface SyncActivityItem {
  id: string;
  path: string;
  filename: string;
  direction: "upload" | "download" | "delete";
  status: "pending" | "active" | "completed" | "failed";
  fileSize?: number;
  error?: string;
  timestamp: number;
}

/** Sync plan computed by preview mode (dry-run). */
export interface SyncPlan {
  toDownload: { fileId: string; path: string; size: number }[];
  toUpload: { path: string; size: number }[];
  toDelete: { path: string }[];
  serverSequence: number;
}

const MAX_HISTORY = 50;
const BATCH_SIZE = 20;            // Files per yield-to-event-loop during manifest build
const MAX_CONCURRENT_DOWNLOADS = 3; // Max simultaneous decrypt+write ops on mobile

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
  private pendingInitialDownloads = 0;
  private totalInitialDownloads = 0;
  /** Sequence number held until all downloads finish before persisting. */
  private pendingSequence: number | null = null;
  /** When true, force sync uses pull-from-server strategy. */
  private _forcePull = false;
  /** Count of downloads that failed during the current sync batch. */
  private failedDownloads = 0;
  /** Queued fileIds waiting to be requested — drained by requestNextDownloads(). */
  private downloadQueue: string[] = [];
  /** How many download+decrypt operations are currently in flight. */
  private activeDownloadCount = 0;
  /** Throttle timer for onActivityChange — prevents re-render flood during bulk sync. */
  private activityChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private activityChangePending = false;
  /** Whether a bulk history change is deferred until sync completes. */
  private bulkHistoryPending = false;
  /** The actual current state, including "idle" which ConnectionManager never emits. */
  private _state: SyncState = "disconnected";
  /** Rolling log of recently synced file changes (newest first). */
  readonly history: SyncHistoryEntry[] = [];
  /** Current sync operation active items (cleared after sync). */
  readonly activeItems: SyncActivityItem[] = [];
  /** Live client list pushed by server. */
  private _clientList: ClientSession[] = [];

  onStateChange: SyncStateCallback = () => {};
  onProgress: SyncProgressCallback = () => {};
  /** Called whenever the history array is updated (file synced, connected, etc.). */
  onHistoryChange: () => void = () => {};
  /** Called when activeItems changes (per-file status update during sync). */
  onActivityChange: () => void = () => {};
  /** Called when the server pushes an updated client list. */
  onClientListChange: (clients: ClientSession[]) => void = () => {};

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

  get clientList(): ClientSession[] {
    return this._clientList;
  }

  /** Start sync with password (initial setup — derive key from password). */
  async connect(password: string): Promise<void> {
    if (!this.settings.serverUrl) return;

    // Hash the password for server auth
    const passwordHash = await sha256String(password);

    // If we already have a vault salt, derive the key now
    if (this.settings.vaultSalt) {
      this.vaultKey = await deriveVaultKey(
        password,
        saltFromBase64(this.settings.vaultSalt)
      );
      // Persist the key for auto-reconnect
      this.settings.encryptionKeyB64 = await exportKey(this.vaultKey);
      await this.saveSettings();
    }

    // Store password temporarily for key derivation after receiving salt
    (this as any)._tempPassword = password;

    this.connection.connect(passwordHash);
    this.fileWatcher.start();
  }

  /** Start sync with stored token + stored key (auto-reconnect, no password needed). */
  async connectWithToken(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.authToken || !this.settings.encryptionKeyB64) return;

    // Import the stored key
    this.vaultKey = await importKey(this.settings.encryptionKeyB64);

    this.connection.connect(); // Will use authToken from settings
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
    this.downloadQueue = [];
    this.activeDownloadCount = 0;
    if (this.activityChangeTimer) { clearTimeout(this.activityChangeTimer); this.activityChangeTimer = null; }
    this.activityChangePending = false;
    this.bulkHistoryPending = false;
    this._state = "disconnected";
    this.fileWatcher.stop();
    this.connection.disconnect();
    this.vaultKey = null;
    this.localManifest.clear();
    this.pendingDownloads.clear();
    this.activeItems.length = 0;
    delete (this as any)._tempPassword;
  }

  /** Force a full resync. */
  async forceSync(): Promise<void> {
    if (this.connection.isConnected) {
      this.readyForIncrementalSync = false;
      this._forcePull = true;
      this.settings.lastSequence = 0;
      await this.saveSettings();
      await this.buildLocalManifest();
      this.connection.requestSync(0);
    }
  }

  /** Kick a client by clientId. */
  kickClient(clientId: string): void {
    this.connection.kickClient(clientId);
  }

  /**
   * Compute a sync preview (dry-run) from a server manifest.
   * Returns the plan without executing it.
   */
  async computeSyncPreview(msg: SyncResponseMessage): Promise<SyncPlan> {
    if (!this.vaultKey) return { toDownload: [], toUpload: [], toDelete: [], serverSequence: msg.currentSequence };

    const plan: SyncPlan = { toDownload: [], toUpload: [], toDelete: [], serverSequence: msg.currentSequence };

    const serverFiles = new Map<string, EncryptedFileEntry>();
    for (const entry of msg.entries) {
      serverFiles.set(entry.fileId, entry);
    }

    const strategy = this.settings.initialSyncStrategy ?? "merge";

    if (strategy === "pull" || this._forcePull) {
      for (const [, entry] of serverFiles) {
        if (!entry.deleted) {
          const meta = await decryptMetadata<{ path: string }>(entry.encryptedMeta, this.vaultKey);
          plan.toDownload.push({ fileId: entry.fileId, path: meta?.path ?? entry.fileId, size: entry.size });
        }
      }
      for (const [fileId, local] of this.localManifest) {
        if (!serverFiles.has(fileId)) {
          plan.toDelete.push({ path: local.path });
        }
      }
    } else if (strategy === "push") {
      for (const [, local] of this.localManifest) {
        plan.toUpload.push({ path: local.path, size: local.size });
      }
    } else {
      // Merge
      for (const [fileId, entry] of serverFiles) {
        if (entry.deleted) continue;
        const local = this.localManifest.get(fileId);
        if (!local) {
          const meta = await decryptMetadata<{ path: string }>(entry.encryptedMeta, this.vaultKey);
          plan.toDownload.push({ fileId: entry.fileId, path: meta?.path ?? entry.fileId, size: entry.size });
        } else if (local.path.startsWith(".obsidian/")) {
          const meta = await decryptMetadata<{ path: string }>(entry.encryptedMeta, this.vaultKey);
          plan.toDownload.push({ fileId: entry.fileId, path: meta?.path ?? local.path, size: entry.size });
        } else {
          const winner = resolveConflict(local.mtime, entry.mtime);
          if (winner === "remote") {
            const meta = await decryptMetadata<{ path: string }>(entry.encryptedMeta, this.vaultKey);
            plan.toDownload.push({ fileId: entry.fileId, path: meta?.path ?? local.path, size: entry.size });
          } else {
            plan.toUpload.push({ path: local.path, size: local.size });
          }
        }
      }
      for (const [fileId, local] of this.localManifest) {
        if (!serverFiles.has(fileId) && !local.path.startsWith(".obsidian/")) {
          plan.toUpload.push({ path: local.path, size: local.size });
        }
      }
    }

    return plan;
  }

  /** Execute a previously-computed sync plan. */
  async applySyncPlan(plan: SyncPlan): Promise<void> {
    if (!this.vaultKey) return;

    // Clear and populate active items
    this.activeItems.length = 0;
    let idCounter = 0;

    for (const item of plan.toUpload) {
      this.activeItems.push({
        id: String(idCounter++),
        path: item.path,
        filename: item.path.split("/").pop() ?? item.path,
        direction: "upload",
        status: "pending",
        fileSize: item.size,
        timestamp: Date.now(),
      });
    }
    for (const item of plan.toDelete) {
      this.activeItems.push({
        id: String(idCounter++),
        path: item.path,
        filename: item.path.split("/").pop() ?? item.path,
        direction: "delete",
        status: "pending",
        timestamp: Date.now(),
      });
    }
    for (const item of plan.toDownload) {
      this.activeItems.push({
        id: String(idCounter++),
        path: item.path,
        filename: item.path.split("/").pop() ?? item.path,
        direction: "download",
        status: "pending",
        fileSize: item.size,
        timestamp: Date.now(),
      });
    }
    this.scheduleActivityChange();

    const total = plan.toUpload.length + plan.toDelete.length + plan.toDownload.length;
    let current = 0;

    if (total === 0) {
      this.settings.lastSequence = plan.serverSequence;
      await this.saveSettings();
      this.readyForIncrementalSync = true;
      this._state = "idle";
      this.onStateChange("idle", "Up to date");
      return;
    }

    this.pendingSequence = plan.serverSequence;

    // Process uploads with yield
    const uploadItems = this.activeItems.filter(i => i.direction === "upload");
    await this.processWithYield(uploadItems, async (item, index) => {
      item.status = "active";
      this.scheduleActivityChange();
      current++;
      this.onProgress(current, total, `Uploading ${index + 1}/${uploadItems.length}: ${item.filename}`);
      await this.uploadFile(item.path);
      item.status = "completed";
      this.scheduleActivityChange();
    });

    // Process deletes with yield
    const deleteItems = this.activeItems.filter(i => i.direction === "delete");
    await this.processWithYield(deleteItems, async (item, index) => {
      item.status = "active";
      this.scheduleActivityChange();
      current++;
      this.onProgress(current, total, `Deleting ${index + 1}/${deleteItems.length}: ${item.filename}`);
      await this.deleteLocalFile(item.path);
      item.status = "completed";
      this.scheduleActivityChange();
    });

    if (plan.toDownload.length === 0) {
      this.settings.lastSequence = this.pendingSequence!;
      this.pendingSequence = null;
      await this.saveSettings();
      this.readyForIncrementalSync = true;
      this._state = "idle";
      this.activeItems.length = 0;
      this.onActivityChange();
      this.onStateChange("idle", "Synced");
      return;
    }

    // Queue downloads — only MAX_CONCURRENT_DOWNLOADS in flight at once
    this.totalInitialDownloads = plan.toDownload.length;
    this.pendingInitialDownloads = plan.toDownload.length;
    this.failedDownloads = 0;
    this.downloadQueue = plan.toDownload.map(e => e.fileId);
    this.activeDownloadCount = 0;
    this.onProgress(0, plan.toDownload.length, `Downloading 0 / ${plan.toDownload.length} files`);
    this.requestNextDownloads();
  }

  private setupConnectionCallbacks(): void {
    this.connection.onStateChange = (state, error) => {
      if (state === "idle") {
        if (!this.readyForIncrementalSync) {
          this.recordHistory("Server", "connect");
        }
      } else if (state === "disconnected") {
        if (this.readyForIncrementalSync) {
          this.recordHistory("Server", "disconnect");
        }
      } else if (state === "error" && error) {
        this.recordHistory(error, "error");
        // Handle session revoked
        if (error === "Session revoked") {
          this.handleSessionRevoked();
        }
      }
      this._state = state;
      this.onStateChange(state, error);
    };

    this.connection.onAuthToken = async (token) => {
      this.settings.authToken = token;
      await this.saveSettings();
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
        // Persist the key for auto-reconnect
        this.settings.encryptionKeyB64 = await exportKey(this.vaultKey);
        await this.saveSettings();
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
      this.pendingDownloads.set(msg.fileId, msg);
    };

    this.connection.onBinaryData = async (data) => {
      await this.handleBinaryDownload(data);
    };

    this.connection.onFileUploadAck = (msg) => {
      this.handleUploadAck(msg);
    };

    this.connection.onClientList = (clients) => {
      this._clientList = clients;
      this.onClientListChange(clients);
    };
  }

  /** Handle session revoked: clear stored credentials, show notice. */
  private handleSessionRevoked(): void {
    this.settings.authToken = "";
    this.settings.encryptionKeyB64 = "";
    this.settings.setupComplete = false;
    this.saveSettings();
    new Notice("Advanced Sync: Session revoked. Please re-enter your password in settings.", 8000);
  }

  /** Yield to the event loop between batches to keep UI responsive. */
  private async processWithYield<T>(
    items: T[],
    processor: (item: T, index: number) => Promise<void>,
    batchSize = BATCH_SIZE
  ): Promise<void> {
    for (let i = 0; i < items.length; i++) {
      await processor(items[i], i);
      if ((i + 1) % batchSize === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  /**
   * Request the next batch of downloads from the queue (sliding-window concurrency).
   * Caps in-flight decrypt+write ops at MAX_CONCURRENT_DOWNLOADS to keep mobile responsive.
   */
  private requestNextDownloads(): void {
    while (this.activeDownloadCount < MAX_CONCURRENT_DOWNLOADS && this.downloadQueue.length > 0) {
      const fileId = this.downloadQueue.shift()!;
      this.activeDownloadCount++;
      this.connection.send({ type: MessageType.FILE_DOWNLOAD, fileId });
    }
  }

  /**
   * Throttled activity change notification — fires immediately, then at most once per 150 ms.
   * Prevents re-rendering the sidebar on every single downloaded file.
   */
  private scheduleActivityChange(): void {
    if (this.activityChangeTimer !== null) {
      this.activityChangePending = true;
      return;
    }
    this.onActivityChange();
    this.activityChangeTimer = setTimeout(() => {
      this.activityChangeTimer = null;
      if (this.activityChangePending) {
        this.activityChangePending = false;
        this.scheduleActivityChange();
      }
    }, 150);
  }

  /**
   * Fire onHistoryChange immediately during incremental sync, but defer during bulk
   * initial sync so we don't re-render the history list for every single file.
   */
  private notifyHistoryChange(isBulk = false): void {
    if (isBulk) {
      this.bulkHistoryPending = true;
    } else {
      this.onHistoryChange();
    }
  }

  /** Build a manifest of all local files for sync comparison. */
  async buildLocalManifest(): Promise<void> {
    if (!this.vaultKey) return;

    this.localManifest.clear();
    const files = this.app.vault.getFiles();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (this.fileWatcher.shouldExclude(file.path)) continue;

      const fileId = await deriveFileId(file.path, this.vaultKey);
      this.localManifest.set(fileId, {
        path: file.path,
        fileId,
        mtime: file.stat.mtime,
        size: file.stat.size,
        contentHash: "",
      });
      // Yield every batch
      if ((i + 1) % BATCH_SIZE === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Scan .obsidian/ files using adapter
    await this.scanAdapterFiles();
  }

  /** Scan .obsidian/ files via adapter.list() for plugin & settings sync. */
  private async scanAdapterFiles(): Promise<void> {
    if (!this.vaultKey) return;
    const adapter = this.app.vault.adapter;

    if (this.settings.syncPlugins) {
      await this.scanAdapterDir(adapter, ".obsidian/plugins");
    }

    if (this.settings.syncSettings) {
      try {
        const listing = await adapter.list(".obsidian");

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

      for (let i = 0; i < listing.files.length; i++) {
        const filePath = listing.files[i];
        if (this.fileWatcher.shouldExclude(filePath)) continue;
        const fileId = await deriveFileId(filePath, this.vaultKey!);
        if (this.localManifest.has(fileId)) continue;

        const stat = await adapter.stat(filePath);
        if (!stat || stat.type !== "file") continue;

        this.localManifest.set(fileId, {
          path: filePath, fileId, mtime: stat.mtime, size: stat.size, contentHash: "",
        });

        // Yield to event loop every BATCH_SIZE files to keep UI responsive
        if ((i + 1) % BATCH_SIZE === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }

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
    const toDelete: string[] = [];

    const serverFiles = new Map<string, EncryptedFileEntry>();
    for (const entry of msg.entries) {
      serverFiles.set(entry.fileId, entry);
    }

    if (msg.fullSync) {
      if (this._forcePull) {
        this._forcePull = false;
        for (const [, entry] of serverFiles) {
          if (!entry.deleted) toDownload.push(entry);
        }
        for (const [fileId, local] of this.localManifest) {
          if (!serverFiles.has(fileId)) toDelete.push(local.path);
        }
      } else {
        const strategy = this.settings.initialSyncStrategy ?? "merge";
        this.settings.initialSyncStrategy = "merge";
        await this.saveSettings();

        if (strategy === "pull") {
          for (const [, entry] of serverFiles) {
            if (!entry.deleted) toDownload.push(entry);
          }
          for (const [fileId, local] of this.localManifest) {
            if (!serverFiles.has(fileId)) toDelete.push(local.path);
          }
        } else if (strategy === "push") {
          for (const [, local] of this.localManifest) {
            toUpload.push(local);
          }
          for (const [fileId] of serverFiles) {
            if (!this.localManifest.has(fileId)) {
              this.connection.send({ type: MessageType.FILE_DELETE, fileId });
            }
          }
        } else {
          for (const [fileId, entry] of serverFiles) {
            if (entry.deleted) continue;
            const local = this.localManifest.get(fileId);
            if (!local) {
              toDownload.push(entry);
            } else if (local.path.startsWith(".obsidian/")) {
              toDownload.push(entry);
            } else {
              const winner = resolveConflict(local.mtime, entry.mtime);
              if (winner === "remote") toDownload.push(entry);
              else toUpload.push(local);
            }
          }
          for (const [fileId, local] of this.localManifest) {
            if (!serverFiles.has(fileId)) {
              if (local.path.startsWith(".obsidian/")) continue;
              toUpload.push(local);
            }
          }
        }
      }
    } else {
      // Incremental sync
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

    // Populate active items for activity tracking
    this.activeItems.length = 0;
    let idCounter = 0;
    for (const local of toUpload) {
      this.activeItems.push({
        id: String(idCounter++), path: local.path,
        filename: local.path.split("/").pop() ?? local.path,
        direction: "upload", status: "pending", fileSize: local.size, timestamp: Date.now(),
      });
    }
    for (const path of toDelete) {
      this.activeItems.push({
        id: String(idCounter++), path,
        filename: path.split("/").pop() ?? path,
        direction: "delete", status: "pending", timestamp: Date.now(),
      });
    }
    for (const entry of toDownload) {
      this.activeItems.push({
        id: String(idCounter++), path: entry.fileId,
        filename: entry.fileId.substring(0, 8) + "...",
        direction: "download", status: "pending", fileSize: entry.size, timestamp: Date.now(),
      });
    }
    if (total > 0) this.scheduleActivityChange();

    let current = 0;

    if (total === 0) {
      this.settings.lastSequence = msg.currentSequence;
      await this.saveSettings();
      this.readyForIncrementalSync = true;
      this._state = "idle";
      this.onStateChange("idle", "Up to date");
      return;
    }

    this.pendingSequence = msg.currentSequence;

    // Process uploads with yield
    const uploadItems = this.activeItems.filter(i => i.direction === "upload");
    await this.processWithYield(uploadItems, async (item, index) => {
      item.status = "active";
      this.scheduleActivityChange();
      current++;
      this.onProgress(current, total, `Uploading ${index + 1}/${uploadItems.length}: ${item.filename}`);
      await this.uploadFile(item.path);
      item.status = "completed";
      this.scheduleActivityChange();
    });

    // Process deletes with yield
    const deleteItems = this.activeItems.filter(i => i.direction === "delete");
    await this.processWithYield(deleteItems, async (item, index) => {
      item.status = "active";
      this.scheduleActivityChange();
      current++;
      this.onProgress(current, total, `Deleting ${index + 1}/${deleteItems.length}: ${item.filename}`);
      await this.deleteLocalFile(item.path);
      item.status = "completed";
      this.scheduleActivityChange();
    });

    if (toDownload.length === 0) {
      this.settings.lastSequence = this.pendingSequence!;
      this.pendingSequence = null;
      await this.saveSettings();
      this.readyForIncrementalSync = true;
      this._state = "idle";
      this.activeItems.length = 0;
      this.onActivityChange();
      this.onStateChange("idle", "Synced");
      return;
    }

    // Queue downloads — only MAX_CONCURRENT_DOWNLOADS in flight at once
    this.totalInitialDownloads = toDownload.length;
    this.pendingInitialDownloads = toDownload.length;
    this.failedDownloads = 0;
    this.downloadQueue = toDownload.map(e => e.fileId);
    this.activeDownloadCount = 0;
    this.onProgress(0, toDownload.length, `Downloading 0 / ${toDownload.length} files`);
    this.requestNextDownloads();
  }

  /** Record a file change in the history log. */
  private recordHistory(path: string, direction: SyncHistoryEntry["direction"]): void {
    const LOOK_BACK = 5;
    for (let i = 0; i < Math.min(LOOK_BACK, this.history.length); i++) {
      const entry = this.history[i];
      if (entry.path === path && entry.direction === direction) {
        entry.count++;
        entry.timestamp = Date.now();
        if (i > 0) {
          this.history.splice(i, 1);
          this.history.unshift(entry);
        }
        this.notifyHistoryChange(this.pendingInitialDownloads > 0);
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
    this.notifyHistoryChange(this.pendingInitialDownloads > 0);
  }

  /** Upload a local file to the server. */
  private async uploadFile(filePath: string): Promise<void> {
    if (!this.vaultKey) return;

    try {
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

      // Send raw encrypted blob (binary frame) — no base64/JSON wrapping
      this.connection.sendBinary(encrypted);

      this.recordHistory(filePath, "upload");

      // Update local manifest
      this.localManifest.set(fileId, {
        path: filePath, fileId, mtime, size, contentHash: "",
      });
    } catch (err: any) {
      console.error(`[Sync] Failed to upload ${filePath}:`, err.message);
    }
  }

  /** Handle incoming binary data (file download). */
  private async handleBinaryDownload(data: ArrayBuffer): Promise<void> {
    if (!this.vaultKey) return;

    let entry: FileDownloadResponseMessage | undefined;
    let downloadFileId: string | undefined;

    for (const [fileId, msg] of this.pendingDownloads) {
      entry = msg;
      downloadFileId = fileId;
      break;
    }

    if (!entry || !downloadFileId) return;
    this.pendingDownloads.delete(downloadFileId);

    // Update activity item status
    const activityItem = this.activeItems.find(
      i => i.direction === "download" && i.path === downloadFileId
    );
    if (activityItem) {
      activityItem.status = "active";
      this.scheduleActivityChange();
    }

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

      // Update activity item with real path
      if (activityItem) {
        activityItem.path = filePath;
        activityItem.filename = filePath.split("/").pop() ?? filePath;
        activityItem.fileSize = entry.size;
        this.scheduleActivityChange();
      }

      // Decrypt the raw binary blob directly — no JSON parsing needed
      const decrypted = await decryptBlob(data, this.vaultKey);
      if (!decrypted) {
        console.error("[Sync] Failed to decrypt blob for", filePath);
        failed = true;
        return;
      }

      if (this.fileWatcher.shouldExclude(filePath)) {
        return;
      }

      // Write file to vault
      await this.writeFile(filePath, decrypted, entry.mtime);
      this.recordHistory(filePath, "download");

      // Update local manifest
      this.localManifest.set(downloadFileId, {
        path: filePath, fileId: downloadFileId, mtime: entry.mtime, size: entry.size, contentHash: "",
      });

      if (filePath.startsWith(".obsidian/plugins/")) {
        this.pluginFilesChanged = true;
      }

      if (activityItem) {
        activityItem.status = "completed";
        this.scheduleActivityChange();
      }
    } catch (err: any) {
      console.error("[Sync] Error processing download:", err.message);
      failed = true;
    } finally {
      if (failed) {
        this.failedDownloads++;
        this.recordHistory(filePath ?? downloadFileId!, "error");
        if (activityItem) {
          activityItem.status = "failed";
          activityItem.error = "Decryption failed";
          this.scheduleActivityChange();
        }
      }

      if (this.pendingInitialDownloads > 0) {
        this.pendingInitialDownloads--;
        const received = this.totalInitialDownloads - this.pendingInitialDownloads;
        this.onProgress(
          received,
          this.totalInitialDownloads,
          `Downloading ${received} / ${this.totalInitialDownloads} files`
        );

        // Free the slot and pull the next queued download
          this.activeDownloadCount = Math.max(0, this.activeDownloadCount - 1);
          this.requestNextDownloads();

          if (this.pendingInitialDownloads === 0) {
          this.totalInitialDownloads = 0;

          if (this.pendingSequence !== null) {
            this.settings.lastSequence = this.pendingSequence;
            this.pendingSequence = null;
            this.saveSettings();
          }

          if (this.failedDownloads > 0) {
            new Notice(`Sync: ${this.failedDownloads} file(s) failed to download. Check Recent Changes for details.`);
            this.failedDownloads = 0;
          }

          this.readyForIncrementalSync = true;
          this._state = "idle";
          this.activeItems.length = 0;
          this.onActivityChange();
          // Flush deferred history notifications now that bulk sync is done
          if (this.bulkHistoryPending) {
            this.bulkHistoryPending = false;
            this.onHistoryChange();
          }
          this.onStateChange("idle", "Synced");
        }
      }
    }
  }

  /** Handle a remote file change notification (real-time from another client). */
  private async handleRemoteFileChanged(msg: FileChangedMessage): Promise<void> {
    if (msg.sourceClientId === this.settings.clientId) return;

    if (msg.sequence > this.settings.lastSequence) {
      this.settings.lastSequence = msg.sequence;
      await this.saveSettings();
    }

    const local = this.localManifest.get(msg.fileId);
    if (local) {
      const winner = resolveConflict(local.mtime, msg.mtime);
      if (winner === "local") return;
    }

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
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dir) {
        try {
          await this.app.vault.adapter.mkdir(dir);
        } catch {
          // Directory may already exist
        }
      }

      await this.app.vault.adapter.writeBinary(filePath, content);

      if (filePath.startsWith(".obsidian/")) {
        const stat = await this.app.vault.adapter.stat(filePath);
        if (stat) this.fileWatcher.setCachedMtime(filePath, stat.mtime);
      }
    } catch (err: any) {
      console.error(`[Sync] Failed to write ${filePath}:`, err.message);
    } finally {
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

  checkPluginChanges(): void {
    this.pluginFilesChanged = false;
  }
}
