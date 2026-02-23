/**
 * Advanced Sync Server entry point.
 * HTTP/WS by default (data is already E2E encrypted).
 */

import http from "http";
import https from "https";
import path from "path";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { loadConfig } from "./config";
import { Storage } from "./storage";
import { Auth } from "./auth";
import { SyncWebSocketServer } from "./websocket";
import { DiscoveryServer } from "./discovery";
import { ensureTlsCerts } from "./tls";

const config = loadConfig();
const useTls = process.env.USE_TLS === "true";

console.log(`[Server] Starting Advanced Sync Server...`);
console.log(`[Server] Data directory: ${config.dataDir}`);
console.log(`[Server] Port: ${config.port}`);
console.log(`[Server] TLS: ${useTls ? "enabled" : "disabled (data is E2E encrypted)"}`);
console.log(`[Server] Discovery port: ${config.discoveryPort}`);

const storage = new Storage(config);
console.log("[Server] Storage initialized.");

const auth = new Auth(config);

const app = express();
app.use(express.json({ limit: "64kb" }));

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
app.use("/", express.static(path.join(__dirname, "web-ui")));

// ---- Auth middleware ----

/** Validates the dashboard session token (password hash) from the Authorization header. */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = (req.headers.authorization ?? "") as string;
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
  res.json({ status: "ok", uptime: process.uptime() });
});

// Dashboard login: validate password, return ok so client can store the hash as session token
app.post("/api/ui-auth", (req, res) => {
  const ip =
    ((req.headers["x-forwarded-for"] ?? "") as string).split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const { passwordHash } = (req.body ?? {}) as { passwordHash?: string };
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
let currentTheme: Record<string, string> = {};

app.get("/api/theme", (_req, res) => {
  res.json(currentTheme);
});

app.post("/api/theme", (req, res) => {
  currentTheme = (req.body as Record<string, string>) || {};
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
    online:  sessions.filter((s) => s.isOnline),
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
  storage.deleteClientSession(clientId);
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
let server: http.Server | https.Server;
if (useTls) {
  const tls = ensureTlsCerts(config);
  server = https.createServer({ cert: tls.cert, key: tls.key }, app);
} else {
  server = http.createServer(app);
}

let wsServer: SyncWebSocketServer;
wsServer = new SyncWebSocketServer(server, storage, auth, config);

const discovery = new DiscoveryServer(config);
discovery.start();

const protocol = useTls ? "https" : "http";
const wsProtocol = useTls ? "wss" : "ws";

server.listen(config.port, () => {
  console.log(`[Server] ${protocol.toUpperCase()} server listening on port ${config.port}`);
  console.log(`[Server] Web UI: ${protocol}://localhost:${config.port}`);
  console.log(`[Server] WebSocket: ${wsProtocol}://localhost:${config.port}/sync`);
});

function shutdown(): void {
  console.log("\n[Server] Shutting down...");
  discovery.stop();
  wsServer.stop();
  storage.close();
  server.close(() => { console.log("[Server] Goodbye."); process.exit(0); });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
