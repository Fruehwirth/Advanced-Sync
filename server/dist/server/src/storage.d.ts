/**
 * Server storage: SQLite for metadata + blob files on disk.
 */
import type { EncryptedFileEntry, ChangeRecord, SyncManifest, ClientSession } from "../../shared/types";
import type { ServerConfig } from "./config";
export declare class Storage {
    private db;
    private blobDir;
    constructor(config: ServerConfig);
    private initSchema;
    getVaultSalt(): string | null;
    setVaultSalt(salt: string): void;
    getCurrentSequence(): number;
    getManifest(): SyncManifest;
    getChangesSince(sequence: number): ChangeRecord[];
    putFile(fileId: string, encryptedMeta: string, mtime: number, size: number, blobData: Buffer): number;
    getFile(fileId: string): Buffer | null;
    getFileMeta(fileId: string): EncryptedFileEntry | null;
    deleteFile(fileId: string): number;
    getStats(): {
        totalFiles: number;
        totalSize: number;
        totalBlobs: number;
    };
    upsertClientSession(clientId: string, deviceName: string, ip: string): void;
    setClientOffline(clientId: string): void;
    getClientSessions(): ClientSession[];
    createToken(token: string, clientId: string, deviceName: string, ip: string): void;
    getToken(token: string): {
        clientId: string;
        deviceName: string;
        ip: string;
        createdAt: number;
        lastUsed: number;
    } | null;
    revokeTokenByClientId(clientId: string): void;
    updateTokenLastUsed(token: string): void;
    getAllTokens(): Array<{
        token: string;
        clientId: string;
        deviceName: string;
        ip: string;
        createdAt: number;
        lastUsed: number;
    }>;
    appendLog(type: string, text: string, timestamp: number): void;
    getLog(limit?: number): Array<{
        type: string;
        text: string;
        timestamp: number;
    }>;
    clearLog(): void;
    reset(): void;
    private getBlobPath;
    close(): void;
}
