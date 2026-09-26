import { Schema, model, type InferSchemaType } from "mongoose";

export const ROLES = ["contributor", "reviewer", "publisher", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * CMS account (plan section 7). Named accounts only; no public sign-up. Passwords are Argon2id
 * hashes and 2-step secrets are encrypted, so the database never holds anything usable directly.
 */
const userSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    roles: { type: [String], enum: ROLES, default: [] },
    /** invited: link sent, setup not finished · active: can sign in · disabled: blocked by an Administrator */
    status: { type: String, enum: ["invited", "active", "disabled"], default: "invited", index: true },
    passwordHash: String,
    mfa: {
      enabled: { type: Boolean, default: false },
      /** Encrypted TOTP secret in use. */
      secret: String,
      /** Encrypted secret being set up, until the first code confirms it. */
      pendingSecret: String,
      /** Last accepted 30-second step: the same code can't be used twice. */
      lastUsedStep: { type: Number, default: -1 },
    },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
    invite: {
      tokenHash: { type: String, index: true, sparse: true },
      expiresAt: Date,
    },
    /** One-hour link an Administrator sends when an active user forgets their password. */
    passwordReset: {
      tokenHash: { type: String, index: true, sparse: true },
      expiresAt: Date,
    },
    lastLoginAt: Date,
    createdBy: String,
  },
  { timestamps: true, versionKey: false },
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model("User", userSchema);
