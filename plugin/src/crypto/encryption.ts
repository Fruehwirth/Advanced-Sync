/**
 * AES-256-GCM encryption/decryption for vault sync.
 * Handles both binary blobs (ArrayBuffer) and text metadata.
 * Uses Web Crypto API — works in Electron and mobile.
 */

import type { EncryptedBlob } from "@vault-sync/shared/types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Generate a random 12-byte IV for AES-GCM. */
function generateIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

/** Convert Uint8Array to base64 string. */
function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

/** Convert base64 string to Uint8Array. */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encrypt an ArrayBuffer (file content) using AES-256-GCM.
 * Returns an EncryptedBlob with base64-encoded IV and ciphertext.
 */
export async function encryptBlob(
  data: ArrayBuffer,
  key: CryptoKey
): Promise<EncryptedBlob> {
  const iv = generateIv();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  return {
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt an EncryptedBlob back to an ArrayBuffer.
 * Returns null if decryption fails (wrong key or corrupted data).
 */
export async function decryptBlob(
  blob: EncryptedBlob,
  key: CryptoKey
): Promise<ArrayBuffer | null> {
  try {
    const iv = fromBase64(blob.iv);
    const ciphertext = fromBase64(blob.ciphertext);
    return await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
  } catch {
    return null;
  }
}

/**
 * Encrypt metadata (a JSON-serializable object) into a base64 string.
 * Format: base64(iv + ciphertext) where iv is first 12 bytes.
 */
export async function encryptMetadata(
  meta: Record<string, any>,
  key: CryptoKey
): Promise<string> {
  const iv = generateIv();
  const plaintext = encoder.encode(JSON.stringify(meta));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );
  // Concatenate iv + ciphertext into a single array
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(combined);
}

/**
 * Decrypt metadata from a base64 string back to a parsed object.
 * Returns null if decryption fails.
 */
export async function decryptMetadata<T = Record<string, any>>(
  encrypted: string,
  key: CryptoKey
): Promise<T | null> {
  try {
    const combined = fromBase64(encrypted);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return JSON.parse(decoder.decode(decrypted));
  } catch {
    return null;
  }
}

/**
 * Compute SHA-256 hash of content, returned as hex string.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute SHA-256 hash of a string, returned as hex string.
 */
export async function sha256String(text: string): Promise<string> {
  return sha256Hex(encoder.encode(text).buffer);
}

export { toBase64, fromBase64 };
