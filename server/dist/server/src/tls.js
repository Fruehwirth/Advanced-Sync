"use strict";
/**
 * Self-signed TLS certificate generation for the server.
 * Generates on first start, reuses from disk after.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureTlsCerts = ensureTlsCerts;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
/**
 * Get or generate TLS certificate and key.
 * Stored in {dataDir}/tls/
 */
function ensureTlsCerts(config) {
    const tlsDir = path_1.default.join(config.dataDir, "tls");
    const certPath = path_1.default.join(tlsDir, "cert.pem");
    const keyPath = path_1.default.join(tlsDir, "key.pem");
    // Return existing certs if they exist
    if (fs_1.default.existsSync(certPath) && fs_1.default.existsSync(keyPath)) {
        return {
            cert: fs_1.default.readFileSync(certPath, "utf-8"),
            key: fs_1.default.readFileSync(keyPath, "utf-8"),
        };
    }
    console.log("[TLS] Generating self-signed certificate...");
    fs_1.default.mkdirSync(tlsDir, { recursive: true });
    // Generate RSA key pair
    const { privateKey, publicKey } = crypto_1.default.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    // Create self-signed certificate using Node.js crypto
    // We use a simple approach: generate the cert via openssl-like structure
    const cert = generateSelfSignedCert(privateKey, publicKey, config.hostname);
    fs_1.default.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    fs_1.default.writeFileSync(certPath, cert);
    console.log("[TLS] Certificate generated and saved.");
    return { cert, key: privateKey };
}
/**
 * Generate a minimal self-signed X.509 certificate.
 * Uses Node.js built-in crypto for signing.
 */
function generateSelfSignedCert(privateKeyPem, publicKeyPem, hostname) {
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
        const tmpKey = path_1.default.join(tmpDir, "as-key.pem");
        const tmpCert = path_1.default.join(tmpDir, "as-cert.pem");
        fs_1.default.writeFileSync(tmpKey, privateKeyPem, { mode: 0o600 });
        execSync(`openssl req -new -x509 -key "${tmpKey}" -out "${tmpCert}" -days 3650 -subj "/CN=${hostname}" -addext "subjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1" 2>/dev/null`, { timeout: 10000 });
        const cert = fs_1.default.readFileSync(tmpCert, "utf-8");
        // Cleanup temp files
        try {
            fs_1.default.unlinkSync(tmpKey);
        }
        catch { }
        try {
            fs_1.default.unlinkSync(tmpCert);
        }
        catch { }
        return cert;
    }
    catch (err) {
        // If openssl is not available, create a placeholder and warn
        console.warn("[TLS] Could not generate certificate with openssl. Using a basic self-signed cert.");
        console.warn("[TLS] For production, mount your own certs at {dataDir}/tls/cert.pem and key.pem");
        // Fallback: create a minimal self-signed cert using just the key
        // This creates a basic cert that works for development
        const { execSync } = require("child_process");
        try {
            // Try with simpler openssl command
            const result = execSync(`openssl req -new -x509 -key /dev/stdin -days 3650 -subj "/CN=${hostname}" -batch`, { input: privateKeyPem, timeout: 10000 });
            return result.toString("utf-8");
        }
        catch {
            // Last resort: return the public key as a "cert" placeholder
            // The server will still start but TLS won't be properly configured
            console.error("[TLS] Failed to generate certificate. Please provide your own certs.");
            return publicKeyPem;
        }
    }
}
