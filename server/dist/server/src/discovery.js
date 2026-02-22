"use strict";
/**
 * UDP broadcast discovery for local network server discovery.
 * Broadcasts server info every 3 seconds and responds to probe packets.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscoveryServer = void 0;
const dgram_1 = __importDefault(require("dgram"));
class DiscoveryServer {
    constructor(config) {
        this.socket = null;
        this.broadcastInterval = null;
        this.config = config;
    }
    start() {
        this.socket = dgram_1.default.createSocket({ type: "udp4", reuseAddr: true });
        const payload = {
            service: "advanced-sync",
            version: 1,
            port: this.config.port,
            hostname: this.config.hostname,
            serverId: this.config.serverId,
        };
        const message = Buffer.from(JSON.stringify(payload));
        this.socket.on("message", (msg, rinfo) => {
            // Respond to probe packets
            try {
                const probe = JSON.parse(msg.toString());
                if (probe.service === "advanced-sync" && probe.type === "probe") {
                    this.socket?.send(message, rinfo.port, rinfo.address);
                }
            }
            catch {
                // Ignore malformed packets
            }
        });
        this.socket.on("error", (err) => {
            console.error("[Discovery] UDP error:", err.message);
        });
        this.socket.bind(this.config.discoveryPort, () => {
            this.socket?.setBroadcast(true);
            console.log(`[Discovery] Broadcasting on UDP port ${this.config.discoveryPort}`);
            // Broadcast every 3 seconds
            this.broadcastInterval = setInterval(() => {
                try {
                    this.socket?.send(message, this.config.discoveryPort, "255.255.255.255");
                }
                catch (err) {
                    console.error("[Discovery] Broadcast error:", err.message);
                }
            }, 3000);
        });
    }
    stop() {
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
            this.broadcastInterval = null;
        }
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }
}
exports.DiscoveryServer = DiscoveryServer;
