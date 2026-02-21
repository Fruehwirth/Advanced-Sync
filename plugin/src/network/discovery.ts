/**
 * UDP broadcast discovery for finding the sync server.
 * Sends probe packets to ALL network interface subnets (including WireGuard)
 * so servers on VPN networks are also found.
 */

import { DISCOVERY_PORT } from "@vault-sync/shared/protocol";

export interface DiscoveredServer {
  hostname: string;
  port: number;
  serverId: string;
  ip: string;
}

export function isDiscoveryAvailable(): boolean {
  try { require("dgram"); return true; } catch { return false; }
}

/**
 * Calculate the subnet broadcast address for a given IP + netmask.
 * e.g. 10.8.0.2 / 255.255.255.0 → 10.8.0.255
 */
function subnetBroadcast(ip: string, netmask: string): string {
  const ipParts   = ip.split(".").map(Number);
  const maskParts = netmask.split(".").map(Number);
  return ipParts.map((b, i) => (b | (~maskParts[i] & 255))).join(".");
}

/**
 * Return all broadcast addresses for every non-loopback IPv4 interface.
 * This covers LAN, WireGuard (wg0), Docker bridges, etc.
 */
function getAllBroadcasts(): string[] {
  const broadcasts = new Set<string>(["255.255.255.255"]);
  try {
    const os = require("os");
    const ifaces: Record<string, any[]> = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal && addr.netmask) {
          broadcasts.add(subnetBroadcast(addr.address, addr.netmask));
        }
      }
    }
  } catch {}
  return Array.from(broadcasts);
}

export function discoverServers(timeoutMs = 5000): Promise<DiscoveredServer[]> {
  return new Promise((resolve) => {
    if (!isDiscoveryAvailable()) { resolve([]); return; }

    const dgram = require("dgram");
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map<string, DiscoveredServer>();

    socket.on("message", (msg: Buffer, rinfo: any) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.service === "advanced-sync" && data.serverId) {
          found.set(data.serverId, {
            hostname: data.hostname,
            port: data.port,
            serverId: data.serverId,
            ip: rinfo.address,
          });
        }
      } catch {}
    });

    socket.on("error", () => { try { socket.close(); } catch {} resolve([]); });

    socket.bind(DISCOVERY_PORT, () => {
      socket.setBroadcast(true);
      const probe = Buffer.from(
        JSON.stringify({ service: "advanced-sync", type: "probe" })
      );
      // Send to every interface subnet — this reaches WireGuard, LAN, etc.
      for (const broadcast of getAllBroadcasts()) {
        try { socket.send(probe, DISCOVERY_PORT, broadcast); } catch {}
      }
    });

    setTimeout(() => {
      try { socket.close(); } catch {}
      resolve(Array.from(found.values()));
    }, timeoutMs);
  });
}
