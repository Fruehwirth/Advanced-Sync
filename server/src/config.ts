/**
 * Environment-based server configuration.
 */

import path from "path";

export interface ServerConfig {
  /** HTTPS port for WebSocket and Web UI. */
  port: number;
  /** UDP discovery broadcast port. */
  discoveryPort: number;
  /** Data directory for blobs, SQLite DB, and TLS certs. */
  dataDir: string;
  /** Server password (clients must provide SHA-256 hash of this). */
  serverPassword: string;
  /** Hostname for TLS certificate and discovery broadcasts. */
  hostname: string;
  /** Unique server identifier. */
  serverId: string;
}

function getEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export function loadConfig(): ServerConfig {
  const dataDir = getEnv("DATA_DIR", "/data");

  return {
    port: parseInt(getEnv("PORT", "8443"), 10),
    discoveryPort: parseInt(getEnv("DISCOVERY_PORT", "21547"), 10),
    dataDir,
    serverPassword: getEnv("SERVER_PASSWORD", "changeme"),
    hostname: getEnv("HOSTNAME", require("os").hostname()),
    serverId: getEnv("SERVER_ID", generateServerId(dataDir)),
  };
}

function generateServerId(dataDir: string): string {
  const fs = require("fs");
  const idPath = path.join(dataDir, "server-id");
  try {
    return fs.readFileSync(idPath, "utf-8").trim();
  } catch {
    const id = require("crypto").randomUUID();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(idPath, id);
    return id;
  }
}
