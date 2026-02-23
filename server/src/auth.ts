/**
 * Server authentication: password verification, token management, rate limiting.
 */

import crypto from "crypto";
import type { Storage } from "./storage";

interface RateLimitEntry {
  failures: number;
  resetAt: number;
}

const MAX_FAILURES = 5;
const WINDOW_MS = 60_000; // 1 minute

export class Auth {
  private passwordHash: string | null;
  private rateLimits: Map<string, RateLimitEntry> = new Map();

  constructor(storage: Storage) {
    const persisted = storage.getServerPasswordHash();
    this.passwordHash = persisted;
  }

  isInitialized(): boolean {
    return !!this.passwordHash;
  }

  /** Reload auth state from persisted storage (used after full wipe). */
  reload(storage: Storage): void {
    this.passwordHash = storage.getServerPasswordHash();
    this.rateLimits.clear();
  }

  /** One-time initialization. Stores the password hash and enables auth. */
  initialize(passwordHash: string, storage: Storage): { ok: boolean; reason?: string } {
    if (this.passwordHash) {
      return { ok: false, reason: "Already initialized" };
    }
    if (!Auth.isValidHexSha256(passwordHash)) {
      return { ok: false, reason: "Invalid passwordHash" };
    }
    storage.setServerPasswordHash(passwordHash);
    this.passwordHash = passwordHash;
    this.rateLimits.clear();
    return { ok: true };
  }

  private static isValidHexSha256(hash: string): boolean {
    return /^[a-f0-9]{64}$/i.test(hash);
  }

  /**
   * Verify a client's password hash.
   * @param clientHash - SHA-256 hash provided by the client
   * @param ip - Client IP for rate limiting
   * @returns true if authenticated, false if wrong password or rate limited
   */
  verify(clientHash: string, ip: string): { ok: boolean; reason?: string } {
    if (!this.passwordHash) {
      return { ok: false, reason: "Server not initialized" };
    }

    // Check rate limit
    const limit = this.rateLimits.get(ip);
    if (limit) {
      if (Date.now() > limit.resetAt) {
        this.rateLimits.delete(ip);
      } else if (limit.failures >= MAX_FAILURES) {
        return { ok: false, reason: "Too many failed attempts. Try again later." };
      }
    }

    // Compare hashes (constant-time comparison)
    const expected = Buffer.from(this.passwordHash, "hex");
    const provided = Buffer.from(clientHash, "hex");

    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
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
  checkHash(hash: string): boolean {
    try {
      if (!this.passwordHash) return false;
      const expected = Buffer.from(this.passwordHash, "hex");
      const provided = Buffer.from(hash, "hex");
      if (expected.length !== provided.length) return false;
      return crypto.timingSafeEqual(expected, provided);
    } catch {
      return false;
    }
  }

  /** Generate a cryptographically random 64-char hex token (32 random bytes). */
  generateToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /** Validate a session token against the database. Returns the session or null. */
  validateToken(token: string, storage: Storage): { clientId: string; deviceName: string } | null {
    const session = storage.getToken(token);
    if (!session) return null;
    storage.updateTokenLastUsed(token);
    return { clientId: session.clientId, deviceName: session.deviceName };
  }

  /** Revoke all tokens for a given clientId. */
  revokeToken(clientId: string, storage: Storage): void {
    storage.revokeTokenByClientId(clientId);
  }
}
