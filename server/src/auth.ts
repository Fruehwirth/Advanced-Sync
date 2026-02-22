/**
 * Server authentication: password verification + rate limiting.
 */

import crypto from "crypto";
import type { ServerConfig } from "./config";

interface RateLimitEntry {
  failures: number;
  resetAt: number;
}

const MAX_FAILURES = 5;
const WINDOW_MS = 60_000; // 1 minute

export class Auth {
  private passwordHash: string;
  private rateLimits: Map<string, RateLimitEntry> = new Map();

  constructor(config: ServerConfig) {
    // Pre-compute SHA-256 hash of the server password for comparison
    this.passwordHash = crypto
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
  verify(clientHash: string, ip: string): { ok: boolean; reason?: string } {
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
      const expected = Buffer.from(this.passwordHash, "hex");
      const provided = Buffer.from(hash, "hex");
      if (expected.length !== provided.length) return false;
      return crypto.timingSafeEqual(expected, provided);
    } catch {
      return false;
    }
  }
}
