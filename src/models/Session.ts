import { Schema, model } from "mongoose";

/**
 * Signed-in CMS session. The cookie holds a random token; only its SHA-256 hash is stored.
 * A session is "pending" after the password and becomes full only after the 6-digit code.
 */
const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    mfaPassed: { type: Boolean, default: false },
    /** Wrong codes on this pending session; too many ends it. */
    mfaFailures: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: () => new Date() },
    // MongoDB deletes the session automatically when it expires.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true, versionKey: false },
);

export const Session = model("Session", sessionSchema);
