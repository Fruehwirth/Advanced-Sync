"use strict";
/**
 * WebSocket handler for the sync server.
 * Manages client authentication, sync protocol, and real-time broadcasts.
 *
 * Two WebSocket endpoints:
 *   /sync — authenticated sync clients
 *   /ui   — dashboard subscribers (require dashboard auth token in ?auth= query param)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncWebSocketServer = void 0;
const ws_1 = require("ws");
const protocol_1 = require("../../shared/protocol");
/** 256 MB max payload to handle large vault files. */
const MAX_PAYLOAD = 256 * 1024 * 1024;
function fmtSize(b) {
    if (!b)
        return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}
class SyncWebSocketServer {
    constructor(server, storage, auth, config) {
        this.clients = new Map();
        this.uiSubscribers = new Set();
        this.pingInterval = null;
        this.storage = storage;
        this.auth = auth;
        this.config = config;
        // Use noServer:true on both servers and route upgrades manually.
        // Attaching two WebSocketServer instances with path options to the same
        // HTTP server causes the non-matching server to call abortHandshake()
        // on the socket, sending back an HTTP 400 which the client sees as
        // "Invalid frame header". Manual routing is the correct pattern.
        this.wss = new ws_1.WebSocketServer({
            noServer: true,
            maxPayload: MAX_PAYLOAD,
            perMessageDeflate: false,
        });
        this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
        this.uiWss = new ws_1.WebSocketServer({
            noServer: true,
            perMessageDeflate: false,
        });
        this.uiWss.on("connection", (ws, req) => this.handleUIConnection(ws, req));
        // Route upgrade requests to the correct WebSocket server
        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", "http://base");
            if (url.pathname === "/sync") {
                this.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.wss.emit("connection", ws, request);
                });
            }
            else if (url.pathname === "/ui") {
                this.uiWss.handleUpgrade(request, socket, head, (ws) => {
                    this.uiWss.emit("connection", ws, request);
                });
            }
            else {
                socket.destroy();
            }
        });
        // Ping all clients every 30s
        this.pingInterval = setInterval(() => this.pingClients(), 30000);
    }
    handleUIConnection(ws, req) {
        // Validate dashboard auth token from query string
        const url = new URL(req.url ?? "/", "http://base");
        const token = url.searchParams.get("auth") ?? "";
        if (!this.auth.checkHash(token)) {
            ws.close(4003, "Unauthorized");
            return;
        }
        this.uiSubscribers.add(ws);
        // Send current status + log history immediately
        this.sendUIStatus(ws);
        ws.on("close", () => {
            this.uiSubscribers.delete(ws);
        });
    }
    handleConnection(ws, req) {
        const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
            req.socket.remoteAddress ||
            "unknown";
        const client = {
            ws,
            clientId: "",
            deviceName: "",
            ip,
            authenticated: false,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            pendingUpload: null,
        };
        this.clients.set(ws, client);
        ws.on("message", (data, isBinary) => {
            client.lastActivity = Date.now();
            if (isBinary) {
                this.handleBinaryMessage(client, data);
            }
            else {
                this.handleTextMessage(client, data.toString());
            }
        });
        ws.on("close", () => {
            this.clients.delete(ws);
            if (client.authenticated) {
                this.storage.setClientOffline(client.clientId);
                this.storage.appendLog("connect", `${client.deviceName} disconnected`, Date.now());
                console.log(`[WS] Client disconnected: ${client.deviceName} (${client.clientId})`);
                this.broadcastUIEvent("client_disconnected", {
                    clientId: client.clientId,
                    deviceName: client.deviceName,
                });
            }
        });
        ws.on("error", (err) => {
            console.error(`[WS] Client error (${client.ip}):`, err.message);
        });
        // Auto-disconnect unauthenticated clients after 10s
        setTimeout(() => {
            if (!client.authenticated && ws.readyState === ws_1.WebSocket.OPEN) {
                ws.close(4001, "Authentication timeout");
            }
        }, 10000);
    }
    handleTextMessage(client, raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            client.ws.close(4002, "Invalid message format");
            return;
        }
        // Unauthenticated clients can only send AUTH
        if (!client.authenticated) {
            if (msg.type !== protocol_1.MessageType.AUTH) {
                client.ws.close(4003, "Not authenticated");
                return;
            }
            this.handleAuth(client, msg);
            return;
        }
        switch (msg.type) {
            case protocol_1.MessageType.SYNC_REQUEST:
                this.handleSyncRequest(client, msg);
                break;
            case protocol_1.MessageType.FILE_UPLOAD:
                this.handleFileUploadHeader(client, msg);
                break;
            case protocol_1.MessageType.FILE_DOWNLOAD:
                this.handleFileDownload(client, msg);
                break;
            case protocol_1.MessageType.FILE_DELETE:
                this.handleFileDelete(client, msg);
                break;
            case protocol_1.MessageType.PING:
                this.send(client.ws, { type: protocol_1.MessageType.PONG, timestamp: Date.now() });
                break;
            default:
                break;
        }
    }
    handleBinaryMessage(client, data) {
        if (!client.authenticated || !client.pendingUpload) {
            return;
        }
        const upload = client.pendingUpload;
        client.pendingUpload = null;
        const sequence = this.storage.putFile(upload.fileId, upload.encryptedMeta, upload.mtime, upload.size, data);
        // ACK to uploader
        this.send(client.ws, {
            type: protocol_1.MessageType.FILE_UPLOAD_ACK,
            fileId: upload.fileId,
            sequence,
        });
        // Broadcast to other authenticated clients
        for (const [ws, other] of this.clients) {
            if (other.authenticated &&
                other.clientId !== client.clientId &&
                ws.readyState === ws_1.WebSocket.OPEN) {
                this.send(ws, {
                    type: protocol_1.MessageType.FILE_CHANGED,
                    fileId: upload.fileId,
                    encryptedMeta: upload.encryptedMeta,
                    mtime: upload.mtime,
                    size: upload.size,
                    sequence,
                    sourceClientId: client.clientId,
                });
            }
        }
        // Log and broadcast to UI
        this.storage.appendLog("upload", `${client.deviceName} synced ${upload.fileId.substring(0, 8)}... (${fmtSize(upload.size)})`, Date.now());
        this.broadcastUIEvent("file_changed", {
            fileId: upload.fileId,
            size: upload.size,
            clientId: client.clientId,
            deviceName: client.deviceName,
            timestamp: Date.now(),
        });
        console.log(`[WS] File uploaded: ${upload.fileId.substring(0, 8)}... by ${client.deviceName} (seq: ${sequence})`);
    }
    handleAuth(client, msg) {
        // Check protocol version
        if (msg.protocolVersion !== protocol_1.PROTOCOL_VERSION) {
            this.send(client.ws, {
                type: protocol_1.MessageType.AUTH_FAIL,
                reason: `Protocol version mismatch. Expected ${protocol_1.PROTOCOL_VERSION}, got ${msg.protocolVersion}`,
            });
            client.ws.close(4004, "Protocol version mismatch");
            return;
        }
        // Verify password
        const result = this.auth.verify(msg.passwordHash, client.ip);
        if (!result.ok) {
            this.send(client.ws, {
                type: protocol_1.MessageType.AUTH_FAIL,
                reason: result.reason || "Authentication failed",
            });
            return;
        }
        // Authentication successful
        client.authenticated = true;
        client.clientId = msg.clientId;
        client.deviceName = msg.deviceName;
        // Get or create vault salt
        let vaultSalt = this.storage.getVaultSalt() ?? "";
        if (!vaultSalt) {
            // Generate new salt (first client to connect)
            const saltBytes = require("crypto").randomBytes(32);
            vaultSalt = saltBytes.toString("base64");
            this.storage.setVaultSalt(vaultSalt);
        }
        this.send(client.ws, {
            type: protocol_1.MessageType.AUTH_OK,
            serverId: this.config.serverId,
            vaultSalt,
        });
        // Persist session for device history
        this.storage.upsertClientSession(client.clientId, client.deviceName, client.ip);
        console.log(`[WS] Client authenticated: ${client.deviceName} (${client.clientId})`);
        this.storage.appendLog("connect", `${client.deviceName} connected from ${client.ip}`, Date.now());
        this.broadcastUIEvent("client_connected", {
            clientId: client.clientId,
            deviceName: client.deviceName,
            ip: client.ip,
        });
    }
    handleSyncRequest(client, msg) {
        if (msg.lastSequence === 0) {
            // Full sync
            const manifest = this.storage.getManifest();
            this.send(client.ws, {
                type: protocol_1.MessageType.SYNC_RESPONSE,
                entries: manifest.entries,
                currentSequence: manifest.sequence,
                fullSync: true,
            });
        }
        else {
            // Incremental sync
            const changes = this.storage.getChangesSince(msg.lastSequence);
            this.send(client.ws, {
                type: protocol_1.MessageType.SYNC_RESPONSE,
                entries: changes.map((c) => ({
                    fileId: c.fileId,
                    encryptedMeta: c.encryptedMeta,
                    mtime: c.mtime,
                    size: c.size,
                    deleted: c.deleted,
                })),
                currentSequence: this.storage.getCurrentSequence(),
                fullSync: false,
            });
        }
    }
    handleFileUploadHeader(client, msg) {
        // Store the upload header; binary data arrives in the next frame
        client.pendingUpload = msg;
    }
    handleFileDownload(client, msg) {
        const meta = this.storage.getFileMeta(msg.fileId);
        const blob = this.storage.getFile(msg.fileId);
        if (!meta || !blob) {
            // File not found — send empty response
            return;
        }
        // Send metadata as text frame, then blob as binary frame
        this.send(client.ws, {
            type: protocol_1.MessageType.FILE_DOWNLOAD_RESPONSE,
            fileId: meta.fileId,
            encryptedMeta: meta.encryptedMeta,
            mtime: meta.mtime,
            size: meta.size,
        });
        client.ws.send(blob);
    }
    handleFileDelete(client, msg) {
        const sequence = this.storage.deleteFile(msg.fileId);
        // ACK to sender
        this.send(client.ws, {
            type: protocol_1.MessageType.FILE_UPLOAD_ACK,
            fileId: msg.fileId,
            sequence,
        });
        // Broadcast to other authenticated clients
        for (const [ws, other] of this.clients) {
            if (other.authenticated &&
                other.clientId !== client.clientId &&
                ws.readyState === ws_1.WebSocket.OPEN) {
                this.send(ws, {
                    type: protocol_1.MessageType.FILE_REMOVED,
                    fileId: msg.fileId,
                    sequence,
                    sourceClientId: client.clientId,
                });
            }
        }
        this.storage.appendLog("remove", `File ${msg.fileId.substring(0, 8)}... deleted by ${client.deviceName}`, Date.now());
        this.broadcastUIEvent("file_removed", {
            fileId: msg.fileId,
            clientId: client.clientId,
            deviceName: client.deviceName,
            timestamp: Date.now(),
        });
        console.log(`[WS] File deleted: ${msg.fileId.substring(0, 8)}... by ${client.deviceName}`);
    }
    /** Handle file deletion from a client. */
    handleFileRemoval(clientId, fileId) {
        const sequence = this.storage.deleteFile(fileId);
        // Broadcast to other clients
        for (const [ws, client] of this.clients) {
            if (client.authenticated &&
                client.clientId !== clientId &&
                ws.readyState === ws_1.WebSocket.OPEN) {
                this.send(ws, {
                    type: protocol_1.MessageType.FILE_REMOVED,
                    fileId,
                    sequence,
                    sourceClientId: clientId,
                });
            }
        }
        this.storage.appendLog("remove", `File ${fileId.substring(0, 8)}... deleted`, Date.now());
        this.broadcastUIEvent("file_removed", {
            fileId,
            clientId,
            timestamp: Date.now(),
        });
    }
    /** Get list of currently connected (authenticated) clients. */
    getConnectedClients() {
        const result = [];
        for (const [, client] of this.clients) {
            if (client.authenticated) {
                result.push({
                    clientId: client.clientId,
                    deviceName: client.deviceName,
                    ip: client.ip,
                    connectedAt: client.connectedAt,
                    lastActivity: client.lastActivity,
                });
            }
        }
        return result;
    }
    pingClients() {
        const now = Date.now();
        for (const [ws, client] of this.clients) {
            if (ws.readyState === ws_1.WebSocket.OPEN) {
                this.send(ws, { type: protocol_1.MessageType.PING, timestamp: now });
            }
        }
    }
    send(ws, msg) {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
    broadcastUIEvent(event, data) {
        const msg = JSON.stringify({
            type: protocol_1.MessageType.UI_EVENT,
            event,
            data,
        });
        for (const sub of this.uiSubscribers) {
            if (sub.readyState === ws_1.WebSocket.OPEN) {
                sub.send(msg);
            }
            else {
                this.uiSubscribers.delete(sub);
            }
        }
    }
    sendUIStatus(ws) {
        const stats = this.storage.getStats();
        const clients = this.getConnectedClients();
        const log = this.storage.getLog(1000);
        const msg = JSON.stringify({
            type: protocol_1.MessageType.UI_EVENT,
            event: "status",
            data: { stats, clients, log },
        });
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(msg);
        }
    }
    /** Forward Obsidian theme variables to all connected web UI subscribers. */
    broadcastTheme(theme) {
        const msg = JSON.stringify({ type: protocol_1.MessageType.UI_EVENT, event: "theme", data: theme });
        for (const sub of this.uiSubscribers) {
            if (sub.readyState === ws_1.WebSocket.OPEN)
                sub.send(msg);
            else
                this.uiSubscribers.delete(sub);
        }
    }
    stop() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        this.wss.close();
        this.uiWss.close();
    }
}
exports.SyncWebSocketServer = SyncWebSocketServer;
