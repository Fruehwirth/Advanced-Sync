import type { EncryptedFileEntry, ClientSession } from "./types";
/** All message types in the sync protocol. */
export declare enum MessageType {
    AUTH = "AUTH",
    AUTH_OK = "AUTH_OK",
    AUTH_FAIL = "AUTH_FAIL",
    SYNC_REQUEST = "SYNC_REQUEST",
    SYNC_RESPONSE = "SYNC_RESPONSE",
    FILE_UPLOAD = "FILE_UPLOAD",
    FILE_UPLOAD_ACK = "FILE_UPLOAD_ACK",
    FILE_DOWNLOAD = "FILE_DOWNLOAD",
    FILE_DOWNLOAD_RESPONSE = "FILE_DOWNLOAD_RESPONSE",
    FILE_CHANGED = "FILE_CHANGED",
    FILE_REMOVED = "FILE_REMOVED",
    FILE_DELETE = "FILE_DELETE",
    PING = "PING",
    PONG = "PONG",
    UI_SUBSCRIBE = "UI_SUBSCRIBE",
    UI_EVENT = "UI_EVENT",
    CLIENT_LIST = "CLIENT_LIST",
    CLIENT_KICK = "CLIENT_KICK"
}
export interface AuthMessage {
    type: MessageType.AUTH;
    clientId: string;
    deviceName: string;
    /** SHA-256 hash of the server password (for initial auth). */
    passwordHash?: string;
    /** Opaque session token (for reconnect). */
    authToken?: string;
    protocolVersion: number;
}
export interface AuthOkMessage {
    type: MessageType.AUTH_OK;
    serverId: string;
    /** Base64-encoded vault salt (created on first connect, reused after). */
    vaultSalt: string;
    /** Opaque session token for future reconnects. */
    authToken: string;
}
export interface AuthFailMessage {
    type: MessageType.AUTH_FAIL;
    reason: string;
}
export interface SyncRequestMessage {
    type: MessageType.SYNC_REQUEST;
    /** Client's last known sequence number (0 for full sync). */
    lastSequence: number;
}
export interface SyncResponseMessage {
    type: MessageType.SYNC_RESPONSE;
    /** Full manifest (for full sync) or changes since lastSequence. */
    entries: EncryptedFileEntry[];
    /** Current server sequence number. */
    currentSequence: number;
    /** True if this is a full manifest, false if incremental. */
    fullSync: boolean;
}
/** Client → Server: upload a file. Binary data follows in next binary frame. */
export interface FileUploadMessage {
    type: MessageType.FILE_UPLOAD;
    fileId: string;
    encryptedMeta: string;
    mtime: number;
    size: number;
}
export interface FileUploadAckMessage {
    type: MessageType.FILE_UPLOAD_ACK;
    fileId: string;
    sequence: number;
}
/** Client → Server: request file download. */
export interface FileDownloadMessage {
    type: MessageType.FILE_DOWNLOAD;
    fileId: string;
}
/** Server → Client: file data. Binary data follows in next binary frame. */
export interface FileDownloadResponseMessage {
    type: MessageType.FILE_DOWNLOAD_RESPONSE;
    fileId: string;
    encryptedMeta: string;
    mtime: number;
    size: number;
    /** Size of the encrypted blob in bytes (for progress tracking). */
    encryptedSize: number;
}
/** Server → Clients: a file was changed by another client. */
export interface FileChangedMessage {
    type: MessageType.FILE_CHANGED;
    fileId: string;
    encryptedMeta: string;
    mtime: number;
    size: number;
    sequence: number;
    /** clientId of the uploader (so receiver can ignore own changes). */
    sourceClientId: string;
}
/** Server → Clients: a file was removed by another client. */
export interface FileRemovedMessage {
    type: MessageType.FILE_REMOVED;
    fileId: string;
    sequence: number;
    sourceClientId: string;
}
/** Client → Server: delete a file from the server. */
export interface FileDeleteMessage {
    type: MessageType.FILE_DELETE;
    fileId: string;
}
export interface PingMessage {
    type: MessageType.PING;
    timestamp: number;
}
export interface PongMessage {
    type: MessageType.PONG;
    timestamp: number;
}
export interface UISubscribeMessage {
    type: MessageType.UI_SUBSCRIBE;
}
export interface UIEventMessage {
    type: MessageType.UI_EVENT;
    event: "client_connected" | "client_disconnected" | "file_changed" | "file_removed" | "status";
    data: any;
}
/** Server → Clients: push updated client list. */
export interface ClientListMessage {
    type: MessageType.CLIENT_LIST;
    clients: ClientSession[];
}
/** Client/Admin → Server: kick a device. */
export interface ClientKickMessage {
    type: MessageType.CLIENT_KICK;
    targetClientId: string;
}
/** Union of all protocol messages. */
export type ProtocolMessage = AuthMessage | AuthOkMessage | AuthFailMessage | SyncRequestMessage | SyncResponseMessage | FileUploadMessage | FileUploadAckMessage | FileDownloadMessage | FileDownloadResponseMessage | FileChangedMessage | FileRemovedMessage | FileDeleteMessage | PingMessage | PongMessage | UISubscribeMessage | UIEventMessage | ClientListMessage | ClientKickMessage;
/** Current protocol version. */
export declare const PROTOCOL_VERSION = 2;
/** Default server port. */
export declare const DEFAULT_PORT = 8443;
/** UDP discovery port. */
export declare const DISCOVERY_PORT = 21547;
