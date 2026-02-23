"use strict";
/**
 * Server storage: SQLite for metadata + blob files on disk.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Storage = void 0;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
class Storage {
    constructor(config) {
        this.dataDir = config.dataDir;
        this.dbPath = path_1.default.join(this.dataDir, "vault-sync.db");
        this.blobDir = path_1.default.join(this.dataDir, "blobs");
        fs_1.default.mkdirSync(this.dataDir, { recursive: true });
        fs_1.default.mkdirSync(this.blobDir, { recursive: true });
        this.db = new better_sqlite3_1.default(this.dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.initSchema();
    }
    initSchema() {
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
      CREATE TABLE IF NOT EXISTS activity_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        type      TEXT    NOT NULL,
        text      TEXT    NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        ip TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_client ON auth_tokens(client_id);
    `);
    }
    getVaultSalt() {
        const row = this.db.prepare("SELECT value FROM vault_meta WHERE key = 'vault_salt'").get();
        return row?.value ?? null;
    }
    setVaultSalt(salt) {
        this.db.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('vault_salt', ?)").run(salt);
    }
    // ---- Server initialization (password) ----
    getServerPasswordHash() {
        const row = this.db
            .prepare("SELECT value FROM vault_meta WHERE key = 'server_password_hash'")
            .get();
        return row?.value ?? null;
    }
    setServerPasswordHash(passwordHash) {
        this.db
            .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('server_password_hash', ?)")
            .run(passwordHash);
    }
    getCurrentSequence() {
        const row = this.db.prepare("SELECT MAX(sequence) as seq FROM files").get();
        return row?.seq ?? 0;
    }
    getManifest() {
        const entries = this.db.prepare("SELECT file_id, encrypted_meta, mtime, size FROM files WHERE deleted = 0").all();
        return {
            entries: entries.map((r) => ({ fileId: r.file_id, encryptedMeta: r.encrypted_meta, mtime: r.mtime, size: r.size })),
            sequence: this.getCurrentSequence(),
        };
    }
    getChangesSince(sequence) {
        const rows = this.db.prepare("SELECT file_id, encrypted_meta, mtime, size, deleted, sequence FROM files WHERE sequence > ? ORDER BY sequence").all(sequence);
        return rows.map((r) => ({ fileId: r.file_id, encryptedMeta: r.encrypted_meta, mtime: r.mtime, size: r.size, deleted: r.deleted === 1, sequence: r.sequence }));
    }
    putFile(fileId, encryptedMeta, mtime, size, blobData) {
        const existing = this.db
            .prepare("SELECT deleted FROM files WHERE file_id = ?")
            .get(fileId);
        const isNew = !existing || existing.deleted === 1;
        const nextSeq = this.getCurrentSequence() + 1;
        this.db.prepare("INSERT OR REPLACE INTO files (file_id, encrypted_meta, mtime, size, deleted, sequence) VALUES (?, ?, ?, ?, 0, ?)").run(fileId, encryptedMeta, mtime, size, nextSeq);
        const blobPath = this.getBlobPath(fileId);
        fs_1.default.mkdirSync(path_1.default.dirname(blobPath), { recursive: true });
        fs_1.default.writeFileSync(blobPath, blobData);
        return { sequence: nextSeq, isNew };
    }
    getFile(fileId) {
        try {
            return fs_1.default.readFileSync(this.getBlobPath(fileId));
        }
        catch {
            return null;
        }
    }
    getFileMeta(fileId) {
        const row = this.db.prepare("SELECT file_id, encrypted_meta, mtime, size, deleted FROM files WHERE file_id = ?").get(fileId);
        if (!row)
            return null;
        return { fileId: row.file_id, encryptedMeta: row.encrypted_meta, mtime: row.mtime, size: row.size, deleted: row.deleted === 1 };
    }
    deleteFile(fileId) {
        const nextSeq = this.getCurrentSequence() + 1;
        this.db.prepare("UPDATE files SET deleted = 1, sequence = ? WHERE file_id = ?").run(nextSeq, fileId);
        try {
            fs_1.default.unlinkSync(this.getBlobPath(fileId));
        }
        catch { }
        return nextSeq;
    }
    getStats() {
        const row = this.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as totalSize FROM files WHERE deleted = 0").get();
        return { totalFiles: row.count, totalSize: row.totalSize, totalBlobs: row.count };
    }
    // ---- Client sessions ----
    upsertClientSession(clientId, deviceName, ip) {
        const now = Date.now();
        const existing = this.db.prepare("SELECT first_seen FROM client_sessions WHERE client_id = ?").get(clientId);
        const firstSeen = existing?.first_seen ?? now;
        this.db.prepare("INSERT OR REPLACE INTO client_sessions (client_id, device_name, ip, first_seen, last_seen, is_online) VALUES (?, ?, ?, ?, ?, 1)").run(clientId, deviceName, ip, firstSeen, now);
    }
    setClientOffline(clientId) {
        this.db.prepare("UPDATE client_sessions SET is_online = 0, last_seen = ? WHERE client_id = ?").run(Date.now(), clientId);
    }
    deleteClientSession(clientId) {
        this.db.prepare("DELETE FROM client_sessions WHERE client_id = ?").run(clientId);
    }
    getClientSessions() {
        const rows = this.db.prepare("SELECT client_id, device_name, ip, first_seen, last_seen, is_online FROM client_sessions ORDER BY last_seen DESC").all();
        return rows.map((r) => ({ clientId: r.client_id, deviceName: r.device_name, ip: r.ip, firstSeen: r.first_seen, lastSeen: r.last_seen, isOnline: r.is_online === 1 }));
    }
    // ---- Auth tokens ----
    createToken(token, clientId, deviceName, ip) {
        const now = Date.now();
        this.db.prepare("INSERT OR REPLACE INTO auth_tokens (token, client_id, device_name, ip, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)").run(token, clientId, deviceName, ip, now, now);
    }
    getToken(token) {
        const row = this.db.prepare("SELECT client_id, device_name, ip, created_at, last_used FROM auth_tokens WHERE token = ?").get(token);
        if (!row)
            return null;
        return { clientId: row.client_id, deviceName: row.device_name, ip: row.ip, createdAt: row.created_at, lastUsed: row.last_used };
    }
    revokeTokenByClientId(clientId) {
        this.db.prepare("DELETE FROM auth_tokens WHERE client_id = ?").run(clientId);
    }
    updateTokenLastUsed(token) {
        this.db.prepare("UPDATE auth_tokens SET last_used = ? WHERE token = ?").run(Date.now(), token);
    }
    getAllTokens() {
        const rows = this.db.prepare("SELECT token, client_id, device_name, ip, created_at, last_used FROM auth_tokens ORDER BY last_used DESC").all();
        return rows.map((r) => ({ token: r.token, clientId: r.client_id, deviceName: r.device_name, ip: r.ip, createdAt: r.created_at, lastUsed: r.last_used }));
    }
    // ---- Activity log ----
    appendLog(type, text, timestamp) {
        this.db.prepare("INSERT INTO activity_log (type, text, timestamp) VALUES (?, ?, ?)").run(type, text, timestamp);
        // Trim to 2000 entries
        const { count } = this.db.prepare("SELECT COUNT(*) as count FROM activity_log").get();
        if (count > 2200) {
            this.db.prepare("DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT 2000)").run();
        }
    }
    getLog(limit = 1000) {
        return this.db.prepare("SELECT type, text, timestamp FROM activity_log ORDER BY id DESC LIMIT ?").all(limit);
    }
    clearLog() {
        this.db.exec("DELETE FROM activity_log");
    }
    reset() {
        this.db.exec("DELETE FROM files");
        this.db.exec("DELETE FROM vault_meta");
        this.db.exec("DELETE FROM client_sessions");
        this.db.exec("DELETE FROM activity_log");
        this.db.exec("DELETE FROM auth_tokens");
        try {
            fs_1.default.rmSync(this.blobDir, { recursive: true, force: true });
            fs_1.default.mkdirSync(this.blobDir, { recursive: true });
        }
        catch { }
        console.log("[Storage] Reset complete.");
    }
    /** Completely wipe all server data on disk, including password, TLS certs, and server-id. */
    wipeAll() {
        this.db.close();
        // Remove SQLite database (and WAL/shm sidecars)
        try {
            fs_1.default.rmSync(this.dbPath, { force: true });
        }
        catch { }
        try {
            fs_1.default.rmSync(this.dbPath + "-wal", { force: true });
        }
        catch { }
        try {
            fs_1.default.rmSync(this.dbPath + "-shm", { force: true });
        }
        catch { }
        // Remove blobs and TLS certs
        try {
            fs_1.default.rmSync(this.blobDir, { recursive: true, force: true });
        }
        catch { }
        try {
            fs_1.default.rmSync(path_1.default.join(this.dataDir, "tls"), { recursive: true, force: true });
        }
        catch { }
        // Remove server id so a new one is generated on next start
        try {
            fs_1.default.rmSync(path_1.default.join(this.dataDir, "server-id"), { force: true });
        }
        catch { }
        // Recreate base directories
        fs_1.default.mkdirSync(this.dataDir, { recursive: true });
        fs_1.default.mkdirSync(this.blobDir, { recursive: true });
        // Persist a new server id immediately
        const newServerId = crypto_1.default.randomUUID();
        fs_1.default.writeFileSync(path_1.default.join(this.dataDir, "server-id"), newServerId);
        this.db = new better_sqlite3_1.default(this.dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.initSchema();
        console.log("[Storage] Full wipe complete.");
        return newServerId;
    }
    getBlobPath(fileId) {
        return path_1.default.join(this.blobDir, fileId.substring(0, 2), fileId);
    }
    close() { this.db.close(); }
}
exports.Storage = Storage;
