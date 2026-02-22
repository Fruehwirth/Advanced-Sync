/**
 * WebSocket handler for the sync server.
 * Manages client authentication, sync protocol, and real-time broadcasts.
 *
 * Two WebSocket endpoints:
 *   /sync — authenticated sync clients
 *   /ui   — dashboard subscribers (require dashboard auth token in ?auth= query param)
 */
import type http from "http";
import type https from "https";
import type { ClientInfo } from "../../shared/types";
import type { Storage } from "./storage";
import type { Auth } from "./auth";
import type { ServerConfig } from "./config";
export declare class SyncWebSocketServer {
    private wss;
    private uiWss;
    private clients;
    private uiSubscribers;
    private storage;
    private auth;
    private config;
    private pingInterval;
    constructor(server: http.Server | https.Server, storage: Storage, auth: Auth, config: ServerConfig);
    private handleUIConnection;
    private handleConnection;
    private handleTextMessage;
    private handleBinaryMessage;
    private handleAuth;
    private handleSyncRequest;
    private handleFileUploadHeader;
    private handleFileDownload;
    private handleFileDelete;
    /** Handle file deletion from a client. */
    handleFileRemoval(clientId: string, fileId: string): void;
    /** Get list of currently connected (authenticated) clients. */
    getConnectedClients(): ClientInfo[];
    private pingClients;
    private send;
    private broadcastUIEvent;
    private sendUIStatus;
    /** Forward Obsidian theme variables to all connected web UI subscribers. */
    broadcastTheme(theme: Record<string, string>): void;
    stop(): void;
}
