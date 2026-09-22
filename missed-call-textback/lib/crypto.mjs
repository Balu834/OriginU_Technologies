/**
 * Authenticated encryption for integration credentials at rest.
 *
 * AES-256-GCM: the auth tag means a tampered ciphertext fails to decrypt
 * rather than silently yielding altered plaintext — which matters when the
 * plaintext is an access token that would then be sent to Meta.
 *
 * The key itself stays in deployment environment configuration
 * (INTEGRATION_ENCRYPTION_KEY, 32 bytes hex). It is never stored beside
 * the ciphertext, because a key kept next to what it protects protects
 * nothing.
 */
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard
const KEY_BYTES = 32;

export function isValidEncryptionKey(hex) {
  return typeof hex === "string" && /^[0-9a-fA-F]{64}$/.test(hex);
}

/** Generates a key for INTEGRATION_ENCRYPTION_KEY. */
export function generateEncryptionKey() {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}

function keyFrom(hex) {
  if (!isValidEncryptionKey(hex)) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

/** Returns "iv:tag:ciphertext", all hex. Null/empty input stays empty. */
export function encryptSecret(plaintext, keyHex) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return "";
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFrom(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(payload, keyHex) {
  if (!payload) return "";
  const [ivHex, tagHex, dataHex] = String(payload).split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("malformed encrypted value");
  const decipher = crypto.createDecipheriv(ALGORITHM, keyFrom(keyHex), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

/** Shows enough of an identifier to recognise it, never enough to use it. */
export function maskIdentifier(value) {
  const s = String(value ?? "");
  if (s.length <= 4) return s ? "****" : "";
  return `${"*".repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
}
