import { createHash, randomBytes, randomInt } from "node:crypto";

// No 0/O or 1/I, so references can be read out over the phone.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Non-sensitive receipt reference, e.g. RNK-7F3K9Q2A (matches the frontend's receipt pages). */
export function newReference(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `RNK-${out}`;
}

/** 256-bit URL-safe random token for email links. */
export const newToken = () => randomBytes(32).toString("base64url");

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Saves a document with a fresh reference, retrying on the (very unlikely) duplicate. */
export async function createWithReference<T>(create: (reference: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await create(newReference());
    } catch (error) {
      if ((error as { code?: number }).code !== 11000 || attempt >= 2) throw error;
    }
  }
}
