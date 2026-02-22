/**
 * Server authentication: password verification + rate limiting.
 */
import type { ServerConfig } from "./config";
export declare class Auth {
    private passwordHash;
    private rateLimits;
    constructor(config: ServerConfig);
    /**
     * Verify a client's password hash.
     * @param clientHash - SHA-256 hash provided by the client
     * @param ip - Client IP for rate limiting
     * @returns true if authenticated, false if wrong password or rate limited
     */
    verify(clientHash: string, ip: string): {
        ok: boolean;
        reason?: string;
    };
    /**
     * Constant-time hash check without rate limiting.
     * Used by dashboard middleware to validate the stored session token.
     */
    checkHash(hash: string): boolean;
}
