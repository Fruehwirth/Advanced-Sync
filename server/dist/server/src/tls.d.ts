/**
 * Self-signed TLS certificate generation for the server.
 * Generates on first start, reuses from disk after.
 */
import type { ServerConfig } from "./config";
export interface TlsFiles {
    cert: string;
    key: string;
}
/**
 * Get or generate TLS certificate and key.
 * Stored in {dataDir}/tls/
 */
export declare function ensureTlsCerts(config: ServerConfig): TlsFiles;
