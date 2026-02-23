/**
 * Environment-based server configuration.
 */
export interface ServerConfig {
    /** HTTPS port for WebSocket and Web UI. */
    port: number;
    /** UDP discovery broadcast port. */
    discoveryPort: number;
    /** Data directory for blobs, SQLite DB, and TLS certs. */
    dataDir: string;
    /** Hostname for TLS certificate and discovery broadcasts. */
    hostname: string;
    /** Unique server identifier. */
    serverId: string;
}
export declare function loadConfig(): ServerConfig;
