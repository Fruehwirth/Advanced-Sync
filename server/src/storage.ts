/**
 * Server storage: SQLite for metadata + blob files on disk.
 */

import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import type { EncryptedFileEntry, ChangeRecord, SyncManifest } from "../../shared/types";
import type { ServerConfig } from "./config";

export interface ClientSession {
  clientId: string;
  deviceName: string;
  ip: string;
  firstSeen: number;
  lastSeen: number;
  isOnline: boolean;
}

export class Storage {
  private db: Database.Database;
  private blobDir: string;

  constructor(config: ServerConfig) {
    const dbPath = path.join(config.dataDir, "vault-sync.db");
    this.blobDir = path.join(config.dataDir, "blobs");
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        file_id TEXT PRIMARY KEY,
        encrypted_meta TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_sessions (
        client_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        is_online INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_files_sequence ON files(sequence);
    `);
  }

  getVaultSalt(): string | null {
    const row = this.db.prepare("SELECT value FROM vault_meta WHERE key = 'vault_salt'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setVaultSalt(salt: string): void {
    this.db.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('vault_salt', ?)").run(salt);
  }

  getCurrentSequence(): number {
    const row = this.db.prepare("SELECT MAX(sequence) as seq FROM files").get() as { seq: number | null };
    return row?.seq ?? 0;
  }

  getManifest(): SyncManifest {
    const entries = this.db.prepare("SELECT file_id, encrypted_meta, mtime, size FROM files WHERE deleted = 0").all() as Array<{ file_id: string; encrypted_meta: string; mtime: number; size: number }>;
    return {
      entries: entries.map((r) => ({ fileId: r.file_id, encryptedMeta: r.encrypted_meta, mtime: r.mtime, size: r.size })),
      sequence: this.getCurrentSequence(),
    };
  }

  getChangesSince(sequence: number): ChangeRecord[] {
    const rows = this.db.prepare("SELECT file_id, encrypted_meta, mtime, size, deleted, sequence FROM files WHERE sequence > ? ORDER BY sequence").all(sequence) as Array<{ file_id: string; encrypted_meta: string; mtime: number; size: number; deleted: number; sequence: number }>;
    return rows.map((r) => ({ fileId: r.file_id, encryptedMeta: r.encrypted_meta, mtime: r.mtime, size: r.size, deleted: r.deleted === 1, sequence: r.sequence }));
  }

  putFile(fileId: string, encryptedMeta: string, mtime: number, size: number, blobData: Buffer): number {
    const nextSeq = this.getCurrentSequence() + 1;
    this.db.prepare("INSERT OR REPLACE INTO files (file_id, encrypted_meta, mtime, size, deleted, sequence) VALUES (?, ?, ?, ?, 0, ?)").run(fileId, encryptedMeta, mtime, size, nextSeq);
    const blobPath = this.getBlobPath(fileId);
    fs.mkdirSync(path.dirname(blobPath), { recursive: true });
    fs.writeFileSync(blobPath, blobData);
    return nextSeq;
  }

  getFile(fileId: string): Buffer | null {
    try { return fs.readFileSync(this.getBlobPath(fileId)); } catch { return null; }
  }

  getFileMeta(fileId: string): EncryptedFileEntry | null {
    const row = this.db.prepare("SELECT file_id, encrypted_meta, mtime, size, deleted FROM files WHERE file_id = ?").get(fileId) as { file_id: string; encrypted_meta: string; mtime: number; size: number; deleted: number } | undefined;
    if (!row) return null;
    return { fileId: row.file_id, encryptedMeta: row.encrypted_meta, mtime: row.mtime, size: row.size, deleted: row.deleted === 1 };
  }

  deleteFile(fileId: string): number {
    const nextSeq = this.getCurrentSequence() + 1;
    this.db.prepare("UPDATE files SET deleted = 1, sequence = ? WHERE file_id = ?").run(nextSeq, fileId);
    try { fs.unlinkSync(this.getBlobPath(fileId)); } catch {}
    return nextSeq;
  }

  getStats(): { totalFiles: number; totalSize: number; totalBlobs: number } {
    const row = this.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as totalSize FROM files WHERE deleted = 0").get() as { count: number; totalSize: number };
    return { totalFiles: row.count, totalSize: row.totalSize, totalBlobs: row.count };
  }

  // ---- Client sessions ----

  upsertClientSession(clientId: string, deviceName: string, ip: string): void {
    const now = Date.now();
    const existing = this.db.prepare("SELECT first_seen FROM client_sessions WHERE client_id = ?").get(clientId) as { first_seen: number } | undefined;
    const firstSeen = existing?.first_seen ?? now;
    this.db.prepare("INSERT OR REPLACE INTO client_sessions (client_id, device_name, ip, first_seen, last_seen, is_online) VALUES (?, ?, ?, ?, ?, 1)").run(clientId, deviceName, ip, firstSeen, now);
  }

  setClientOffline(clientId: string): void {
    this.db.prepare("UPDATE client_sessions SET is_online = 0, last_seen = ? WHERE client_id = ?").run(Date.now(), clientId);
  }

  getClientSessions(): ClientSession[] {
    const rows = this.db.prepare("SELECT client_id, device_name, ip, first_seen, last_seen, is_online FROM client_sessions ORDER BY last_seen DESC").all() as Array<{ client_id: string; device_name: string; ip: string; first_seen: number; last_seen: number; is_online: number }>;
    return rows.map((r) => ({ clientId: r.client_id, deviceName: r.device_name, ip: r.ip, firstSeen: r.first_seen, lastSeen: r.last_seen, isOnline: r.is_online === 1 }));
  }

  reset(): void {
    this.db.exec("DELETE FROM files");
    this.db.exec("DELETE FROM vault_meta");
    this.db.exec("DELETE FROM client_sessions");
    try { fs.rmSync(this.blobDir, { recursive: true, force: true }); fs.mkdirSync(this.blobDir, { recursive: true }); } catch {}
    console.log("[Storage] Reset complete.");
  }

  private getBlobPath(fileId: string): string {
    return path.join(this.blobDir, fileId.substring(0, 2), fileId);
  }

  close(): void { this.db.close(); }
}
