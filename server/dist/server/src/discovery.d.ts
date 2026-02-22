/**
 * UDP broadcast discovery for local network server discovery.
 * Broadcasts server info every 3 seconds and responds to probe packets.
 */
import type { ServerConfig } from "./config";
export interface DiscoveryPayload {
    service: "advanced-sync";
    version: number;
    port: number;
    hostname: string;
    serverId: string;
}
export declare class DiscoveryServer {
    private socket;
    private broadcastInterval;
    private config;
    constructor(config: ServerConfig);
    start(): void;
    stop(): void;
}
