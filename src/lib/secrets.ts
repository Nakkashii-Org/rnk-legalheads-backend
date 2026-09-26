import argon2 from "argon2";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Passwords: Argon2id with the library's recommended defaults (plan section 7). */
export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

export async function verifyPassword(hash: string | undefined | null, password: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A real hash to verify against when the account doesn't exist, so a wrong email takes as long as
 * a wrong password and doesn't reveal which accounts exist.
 */
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));

const COMMON = new Set([
  "password1234", "password12345", "passwordpassword", "123456789012", "qwertyuiopas", "iloveyou1234",
  "welcome12345", "admin1234567", "rnklegalheads", "letmein12345", "changeme1234", "000000000000",
]);

/** Password rules: long enough to be strong, not common, not the person's email. */
export function passwordProblem(password: string, email: string): string | undefined {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 128) return "Use 128 characters or fewer.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return "This password is too common. Choose a less predictable one.";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && lower.includes(local)) return "Don't include your email address in the password.";
  return undefined;
}

/**
 * Encrypts the 2-step verification secret at rest (AES-256-GCM), so a database leak alone
 * doesn't let anyone generate codes.
 */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(sealed: string, key: Buffer): string {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
}
