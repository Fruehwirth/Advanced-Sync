"use strict";
/**
 * Server authentication: password verification, token management, rate limiting.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Auth = void 0;
const crypto_1 = __importDefault(require("crypto"));
const MAX_FAILURES = 5;
const WINDOW_MS = 60000; // 1 minute
class Auth {
    constructor(config) {
        this.rateLimits = new Map();
        // Pre-compute SHA-256 hash of the server password for comparison
        this.passwordHash = crypto_1.default
            .createHash("sha256")
            .update(config.serverPassword)
            .digest("hex");
    }
    /**
     * Verify a client's password hash.
     * @param clientHash - SHA-256 hash provided by the client
     * @param ip - Client IP for rate limiting
     * @returns true if authenticated, false if wrong password or rate limited
     */
    verify(clientHash, ip) {
        // Check rate limit
        const limit = this.rateLimits.get(ip);
        if (limit) {
            if (Date.now() > limit.resetAt) {
                this.rateLimits.delete(ip);
            }
            else if (limit.failures >= MAX_FAILURES) {
                return { ok: false, reason: "Too many failed attempts. Try again later." };
            }
        }
        // Compare hashes (constant-time comparison)
        const expected = Buffer.from(this.passwordHash, "hex");
        const provided = Buffer.from(clientHash, "hex");
        if (expected.length !== provided.length || !crypto_1.default.timingSafeEqual(expected, provided)) {
            // Record failure
            const entry = this.rateLimits.get(ip) || { failures: 0, resetAt: Date.now() + WINDOW_MS };
            entry.failures++;
            entry.resetAt = Date.now() + WINDOW_MS;
            this.rateLimits.set(ip, entry);
            return { ok: false, reason: "Invalid password." };
        }
        // Success — clear any rate limit entries for this IP
        this.rateLimits.delete(ip);
        return { ok: true };
    }
    /**
     * Constant-time hash check without rate limiting.
     * Used by dashboard middleware to validate the stored session token.
     */
    checkHash(hash) {
        try {
            const expected = Buffer.from(this.passwordHash, "hex");
            const provided = Buffer.from(hash, "hex");
            if (expected.length !== provided.length)
                return false;
            return crypto_1.default.timingSafeEqual(expected, provided);
        }
        catch {
            return false;
        }
    }
    /** Generate a cryptographically random 64-char hex token (32 random bytes). */
    generateToken() {
        return crypto_1.default.randomBytes(32).toString("hex");
    }
    /** Validate a session token against the database. Returns the session or null. */
    validateToken(token, storage) {
        const session = storage.getToken(token);
        if (!session)
            return null;
        storage.updateTokenLastUsed(token);
        return { clientId: session.clientId, deviceName: session.deviceName };
    }
    /** Revoke all tokens for a given clientId. */
    revokeToken(clientId, storage) {
        storage.revokeTokenByClientId(clientId);
    }
}
exports.Auth = Auth;
