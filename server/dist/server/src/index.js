"use strict";
/**
 * Advanced Sync Server entry point.
 * HTTP/WS by default (data is already E2E encrypted).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const path_1 = __importDefault(require("path"));
const express_1 = __importDefault(require("express"));
const config_1 = require("./config");
const storage_1 = require("./storage");
const auth_1 = require("./auth");
const websocket_1 = require("./websocket");
const discovery_1 = require("./discovery");
const tls_1 = require("./tls");
const config = (0, config_1.loadConfig)();
const useTls = process.env.USE_TLS === "true";
console.log(`[Server] Starting Advanced Sync Server...`);
console.log(`[Server] Data directory: ${config.dataDir}`);
console.log(`[Server] Port: ${config.port}`);
console.log(`[Server] TLS: ${useTls ? "enabled" : "disabled (data is E2E encrypted)"}`);
console.log(`[Server] Discovery port: ${config.discoveryPort}`);
const storage = new storage_1.Storage(config);
console.log("[Server] Storage initialized.");
const auth = new auth_1.Auth(storage);
if (!auth.isInitialized()) {
    console.warn("[Server] Server is not initialized yet.");
    console.warn("[Server] First device to run setup will set the server password.");
    console.warn("[Server] Do not expose the server to the public internet before initialization.");
}
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: "64kb" }));
// Allow Obsidian (Electron renderer) to call the REST API
app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }
    next();
});
// Static Web UI
app.use("/", express_1.default.static(path_1.default.join(__dirname, "web-ui")));
// ---- Auth middleware ----
/** Validates the dashboard session token (password hash) from the Authorization header. */
function requireAuth(req, res, next) {
    if (!auth.isInitialized()) {
        res.status(428).json({ error: "Server not initialized" });
        return;
    }
    const header = (req.headers.authorization ?? "");
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!auth.checkHash(token)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    next();
}
// ---- Public endpoints ----
// Health check (public — used for uptime polling, no sensitive data)
app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), initialized: auth.isInitialized() });
});
// Initialization status (public)
app.get("/api/init-status", (_req, res) => {
    res.json({ initialized: auth.isInitialized() });
});
// One-time initialization (public): set server password hash
app.post("/api/init", (req, res) => {
    if (auth.isInitialized()) {
        res.status(409).json({ error: "Already initialized" });
        return;
    }
    const { passwordHash } = (req.body ?? {});
    if (!passwordHash) {
        res.status(400).json({ error: "Missing passwordHash" });
        return;
    }
    const result = auth.initialize(passwordHash, storage);
    if (!result.ok) {
        res.status(400).json({ error: result.reason ?? "Initialization failed" });
        return;
    }
    console.log("[Server] Server initialized via /api/init.");
    res.json({ ok: true });
});
// Dashboard login: validate password, return ok so client can store the hash as session token
app.post("/api/ui-auth", (req, res) => {
    if (!auth.isInitialized()) {
        res.status(428).json({ error: "Server not initialized" });
        return;
    }
    const ip = (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() ||
        req.socket.remoteAddress ||
        "unknown";
    const { passwordHash } = (req.body ?? {});
    if (!passwordHash) {
        res.status(400).json({ error: "Missing passwordHash" });
        return;
    }
    const result = auth.verify(passwordHash, ip);
    if (!result.ok) {
        res.status(401).json({ error: result.reason ?? "Invalid password" });
        return;
    }
    res.json({ ok: true });
});
// Obsidian theme variables — kept unauthenticated so the plugin can POST
// without needing to send credentials over REST (plugin authenticates via WS).
let currentTheme = {};
app.get("/api/theme", (_req, res) => {
    res.json(currentTheme);
});
app.post("/api/theme", (req, res) => {
    currentTheme = req.body || {};
    wsServer?.broadcastTheme(currentTheme);
    res.json({ ok: true });
});
// ---- Protected endpoints ----
app.get("/api/stats", requireAuth, (_req, res) => {
    res.json(storage.getStats());
});
app.get("/api/clients", requireAuth, (_req, res) => {
    const sessions = storage.getClientSessions();
    res.json({
        online: sessions.filter((s) => s.isOnline),
        offline: sessions.filter((s) => !s.isOnline),
    });
});
// Session management endpoints
app.get("/api/sessions", requireAuth, (_req, res) => {
    const sessions = storage.getClientSessions();
    res.json(sessions);
});
app.post("/api/sessions/:clientId/revoke", requireAuth, (req, res) => {
    const { clientId } = req.params;
    wsServer?.disconnectClient(clientId);
    res.json({ ok: true });
});
app.get("/api/log", requireAuth, (_req, res) => {
    res.json(storage.getLog(2000));
});
app.post("/api/log/clear", requireAuth, (_req, res) => {
    storage.clearLog();
    res.json({ ok: true });
});
app.post("/api/reset", requireAuth, (_req, res) => {
    storage.reset();
    currentTheme = {};
    console.log("[Server] Storage reset via web UI.");
    res.json({ ok: true });
});
// Create HTTP/HTTPS server
let server;
if (useTls) {
    const tls = (0, tls_1.ensureTlsCerts)(config);
    server = https_1.default.createServer({ cert: tls.cert, key: tls.key }, app);
}
else {
    server = http_1.default.createServer(app);
}
let wsServer;
wsServer = new websocket_1.SyncWebSocketServer(server, storage, auth, config);
const discovery = new discovery_1.DiscoveryServer(config);
discovery.start();
const protocol = useTls ? "https" : "http";
const wsProtocol = useTls ? "wss" : "ws";
server.listen(config.port, () => {
    console.log(`[Server] ${protocol.toUpperCase()} server listening on port ${config.port}`);
    console.log(`[Server] Web UI: ${protocol}://localhost:${config.port}`);
    console.log(`[Server] WebSocket: ${wsProtocol}://localhost:${config.port}/sync`);
});
function shutdown() {
    console.log("\n[Server] Shutting down...");
    discovery.stop();
    wsServer.stop();
    storage.close();
    server.close(() => { console.log("[Server] Goodbye."); process.exit(0); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
