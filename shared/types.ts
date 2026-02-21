/** Metadata about a file in the vault. */
export interface FileMetadata {
  /** Opaque file ID derived via HMAC-SHA256 from vault path + key. */
  fileId: string;
  /** Last-modified timestamp in ms (used for conflict resolution). */
  mtime: number;
  /** Size of the original unencrypted data in bytes. */
  size: number;
  /** SHA-256 hash of the unencrypted content for change detection. */
  contentHash: string;
  /** Whether this file has been deleted (tombstone). */
  deleted?: boolean;
}

/** An encrypted blob stored on the server. */
export interface EncryptedBlob {
  /** Base64-encoded initialization vector. */
  iv: string;
  /** Base64-encoded ciphertext. */
  ciphertext: string;
}

/** A single file entry in the sync manifest. */
export interface EncryptedFileEntry {
  fileId: string;
  /** Encrypted metadata (JSON string encrypted with vault key). */
  encryptedMeta: string;
  mtime: number;
  size: number;
  deleted?: boolean;
}

/** Overall sync state of the plugin. */
export type SyncState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "syncing"
  | "idle"
  | "error";

/** Connection status information. */
export interface ConnectionStatus {
  state: SyncState;
  serverUrl: string | null;
  lastSync: number | null;
  error: string | null;
  connectedClients: number;
}

/** Information about a connected client (for server/web-ui). */
export interface ClientInfo {
  clientId: string;
  deviceName: string;
  ip: string;
  connectedAt: number;
  lastActivity: number;
}

/** Server manifest: list of all file entries. */
export interface SyncManifest {
  entries: EncryptedFileEntry[];
  /** Server-side sequence number for incremental sync. */
  sequence: number;
}

/** Change record for incremental sync. */
export interface ChangeRecord {
  fileId: string;
  encryptedMeta: string;
  mtime: number;
  size: number;
  deleted: boolean;
  sequence: number;
}
