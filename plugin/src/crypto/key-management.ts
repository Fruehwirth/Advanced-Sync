/**
 * Key derivation and management for vault sync encryption.
 * PBKDF2 for key derivation, HMAC-SHA256 for opaque file IDs.
 */

import { toBase64 } from "./encryption";

const encoder = new TextEncoder();

/** PBKDF2 iteration count — 210k with SHA-512 for strong key derivation. */
const PBKDF2_ITERATIONS = 210000;

/**
 * Derive an AES-256-GCM CryptoKey from a password and salt using PBKDF2.
 * The key can encrypt/decrypt and also be used to derive HMAC keys.
 */
export async function deriveVaultKey(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-512",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true, // extractable so we can derive HMAC key from the raw bits
    ["encrypt", "decrypt"]
  );
}

/**
 * Derive a deterministic opaque file ID from a vault path.
 * Uses HMAC-SHA256 with the vault key's raw bits as the HMAC key.
 * This ensures the server never sees real file paths.
 */
export async function deriveFileId(
  path: string,
  vaultKey: CryptoKey
): Promise<string> {
  // Export the AES key's raw bits to use as HMAC key material
  const rawKey = await crypto.subtle.exportKey("raw", vaultKey);
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    encoder.encode(path)
  );

  // Convert to hex string for use as file ID
  const bytes = new Uint8Array(signature);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a random 32-byte vault salt.
 * Created once per vault, stored on the server.
 */
export function generateVaultSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Convert a vault salt to base64 for transport/storage.
 */
export function saltToBase64(salt: Uint8Array): string {
  return toBase64(salt);
}

/**
 * Convert a base64 salt back to Uint8Array.
 */
export function saltFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
