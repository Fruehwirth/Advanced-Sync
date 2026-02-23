/**
 * Server authentication: password verification, token management, rate limiting.
 */
import type { Storage } from "./storage";
export declare class Auth {
    private passwordHash;
    private rateLimits;
    constructor(storage: Storage);
    isInitialized(): boolean;
    /** Reload auth state from persisted storage (used after full wipe). */
    reload(storage: Storage): void;
    /** One-time initialization. Stores the password hash and enables auth. */
    initialize(passwordHash: string, storage: Storage): {
        ok: boolean;
        reason?: string;
    };
    private static isValidHexSha256;
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
    /** Generate a cryptographically random 64-char hex token (32 random bytes). */
    generateToken(): string;
    /** Validate a session token against the database. Returns the session or null. */
    validateToken(token: string, storage: Storage): {
        clientId: string;
        deviceName: string;
    } | null;
    /** Revoke all tokens for a given clientId. */
    revokeToken(clientId: string, storage: Storage): void;
}
