/**
 * Self-signed TLS certificate generation for the server.
 * Generates on first start, reuses from disk after.
 */

import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { ServerConfig } from "./config";

export interface TlsFiles {
  cert: string;
  key: string;
}

/**
 * Get or generate TLS certificate and key.
 * Stored in {dataDir}/tls/
 */
export function ensureTlsCerts(config: ServerConfig): TlsFiles {
  const tlsDir = path.join(config.dataDir, "tls");
  const certPath = path.join(tlsDir, "cert.pem");
  const keyPath = path.join(tlsDir, "key.pem");

  // Return existing certs if they exist
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      cert: fs.readFileSync(certPath, "utf-8"),
      key: fs.readFileSync(keyPath, "utf-8"),
    };
  }

  console.log("[TLS] Generating self-signed certificate...");
  fs.mkdirSync(tlsDir, { recursive: true });

  // Generate RSA key pair
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Create self-signed certificate using Node.js crypto
  // We use a simple approach: generate the cert via openssl-like structure
  const cert = generateSelfSignedCert(privateKey, publicKey, config.hostname);

  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(certPath, cert);

  console.log("[TLS] Certificate generated and saved.");
  return { cert, key: privateKey };
}

/**
 * Generate a minimal self-signed X.509 certificate.
 * Uses Node.js built-in crypto for signing.
 */
function generateSelfSignedCert(
  privateKeyPem: string,
  publicKeyPem: string,
  hostname: string
): string {
  // For a proper self-signed cert without openssl binary dependency,
  // we use Node's X509Certificate support (Node 15+).
  // However, Node doesn't have a built-in cert *creation* API,
  // so we construct a minimal ASN.1 DER certificate manually.

  const crypto = require("crypto");

  // Use Node's createCertificate if available (Node 21+), otherwise
  // fall back to a simple PEM-wrapped approach
  try {
    // Try using the newer Node.js API
    const { X509Certificate } = require("crypto");

    // Since Node doesn't have a simple cert creation API in all versions,
    // we'll create one using the forge-free approach: spawn openssl if available,
    // or use a minimal ASN.1 builder

    // Simplest reliable approach: use child_process to call openssl
    const { execSync } = require("child_process");
    const tmpDir = require("os").tmpdir();
    const tmpKey = path.join(tmpDir, "as-key.pem");
    const tmpCert = path.join(tmpDir, "as-cert.pem");

    fs.writeFileSync(tmpKey, privateKeyPem, { mode: 0o600 });

    execSync(
      `openssl req -new -x509 -key "${tmpKey}" -out "${tmpCert}" -days 3650 -subj "/CN=${hostname}" -addext "subjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1" 2>/dev/null`,
      { timeout: 10000 }
    );

    const cert = fs.readFileSync(tmpCert, "utf-8");

    // Cleanup temp files
    try { fs.unlinkSync(tmpKey); } catch {}
    try { fs.unlinkSync(tmpCert); } catch {}

    return cert;
  } catch (err) {
    // If openssl is not available, create a placeholder and warn
    console.warn(
      "[TLS] Could not generate certificate with openssl. Using a basic self-signed cert."
    );
    console.warn(
      "[TLS] For production, mount your own certs at {dataDir}/tls/cert.pem and key.pem"
    );

    // Fallback: create a minimal self-signed cert using just the key
    // This creates a basic cert that works for development
    const { execSync } = require("child_process");
    try {
      // Try with simpler openssl command
      const result = execSync(
        `openssl req -new -x509 -key /dev/stdin -days 3650 -subj "/CN=${hostname}" -batch`,
        { input: privateKeyPem, timeout: 10000 }
      );
      return result.toString("utf-8");
    } catch {
      // Last resort: return the public key as a "cert" placeholder
      // The server will still start but TLS won't be properly configured
      console.error("[TLS] Failed to generate certificate. Please provide your own certs.");
      return publicKeyPem;
    }
  }
}
