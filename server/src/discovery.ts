/**
 * UDP broadcast discovery for local network server discovery.
 * Broadcasts server info every 3 seconds and responds to probe packets.
 */

import dgram from "dgram";
import type { ServerConfig } from "./config";

export interface DiscoveryPayload {
  service: "advanced-sync";
  version: number;
  port: number;
  hostname: string;
  serverId: string;
}

export class DiscoveryServer {
  private socket: dgram.Socket | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  start(): void {
    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    const payload: DiscoveryPayload = {
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
      } catch {
        // Ignore malformed packets
      }
    });

    this.socket.on("error", (err) => {
      console.error("[Discovery] UDP error:", err.message);
    });

    this.socket.bind(this.config.discoveryPort, () => {
      this.socket?.setBroadcast(true);
      console.log(
        `[Discovery] Broadcasting on UDP port ${this.config.discoveryPort}`
      );

      // Broadcast every 3 seconds
      this.broadcastInterval = setInterval(() => {
        try {
          this.socket?.send(
            message,
            this.config.discoveryPort,
            "255.255.255.255"
          );
        } catch (err: any) {
          console.error("[Discovery] Broadcast error:", err.message);
        }
      }, 3000);
    });
  }

  stop(): void {
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
