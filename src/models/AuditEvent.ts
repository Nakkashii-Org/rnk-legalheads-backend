import { Schema, model } from "mongoose";

/**
 * Permanent record of sign-ins and account changes (B5), and later saves, approvals and
 * publishing (guide p.152). Append-only; never holds passwords, codes, tokens or message text.
 */
const auditEventSchema = new Schema(
  {
    at: { type: Date, required: true, default: () => new Date(), index: true },
    action: { type: String, required: true, index: true },
    /** Who did it (absent for failed sign-ins with an unknown email). */
    actorId: String,
    actorEmail: String,
    /** What it was done to, e.g. another user's email or a content record. */
    target: String,
    /** Short, non-sensitive extra detail, e.g. "roles: reviewer, publisher". */
    detail: String,
  },
  { versionKey: false },
);

export const AuditEvent = model("AuditEvent", auditEventSchema);
