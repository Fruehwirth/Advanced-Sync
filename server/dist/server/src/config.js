"use strict";
/**
 * Environment-based server configuration.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const path_1 = __importDefault(require("path"));
function getEnv(key, fallback) {
    return process.env[key] || fallback;
}
function loadConfig() {
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
function generateServerId(dataDir) {
    const fs = require("fs");
    const idPath = path_1.default.join(dataDir, "server-id");
    try {
        return fs.readFileSync(idPath, "utf-8").trim();
    }
    catch {
        const id = require("crypto").randomUUID();
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(idPath, id);
        return id;
    }
}
