/**
 * Structured one-line JSON logs. Callers pass only operational fields: never message bodies,
 * resumes, tokens or full email addresses (guide p.158, p.166).
 */
type Fields = Record<string, string | number | boolean | undefined>;

function write(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  if (process.env.NODE_ENV === "test" && level === "info") return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  (level === "error" ? console.error : console.log)(line);
}

export const logger = {
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};

/** "priya.sharma@example.com" → "p***@example.com" for logs. */
export const maskEmail = (email: string) => email.replace(/^(.).*(@.*)$/, "$1***$2");
