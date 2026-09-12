/**
 * Generates the DASHBOARD_PASSWORD_HASH value for a chosen password.
 *
 *   node scripts/hash-password.mjs "the password"
 *
 * Paste the output into .env and into the Vercel project's environment.
 * The plaintext password is never stored — only this salted scrypt hash.
 */
import { hashPassword } from "../lib/auth.mjs";

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.mjs "<password>"');
  process.exit(1);
}

console.log(hashPassword(password));
