// Syntax check only; it does not prove the mailbox exists (guide p.136).
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Line breaks in single-line fields are rejected to prevent email header injection.
export const LINE_BREAK = /[\r\n]/;
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type FieldErrors = Record<string, string>;

/** Reads a string field from untrusted input; anything else becomes "". */
export const str = (value: unknown): string => (typeof value === "string" ? value : "");

export const bool = (value: unknown): boolean => value === true || value === "true";

export function emailError(value: string): string | undefined {
  const email = value.trim();
  if (!email) return "Enter your email address.";
  if (email.length > 254 || !EMAIL_PATTERN.test(email) || LINE_BREAK.test(email))
    return "Enter an email address in the format name@example.com.";
  return undefined;
}

export function clean(errors: Record<string, string | undefined>): FieldErrors {
  return Object.fromEntries(Object.entries(errors).filter((e): e is [string, string] => Boolean(e[1])));
}
