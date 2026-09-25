import { Schema, model } from "mongoose";

/**
 * Newsletter link tokens. Only a SHA-256 hash is stored, so a database leak does not expose
 * working links. Brevo remains the source of truth for subscription state (guide p.147).
 *
 * - confirm: sent inside the double opt-in redirect; records the consent that was given.
 * - manage:  used by /preferences and /unsubscribe links in newsletter emails.
 */
const subscriberTokenSchema = new Schema(
  {
    hash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ["confirm", "manage"], required: true },
    email: { type: String, required: true, index: true },
    // Consent record, confirm tokens only: the topics the person agreed to. Current topics live in
    // Brevo, so manage tokens have no topics field (no misleading empty list).
    topics: { type: [String], default: undefined },
    noticeVersion: String,
    consentAt: Date,
    confirmedAt: Date,
    // MongoDB removes expired tokens automatically.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

export const SubscriberToken = model("SubscriberToken", subscriberTokenSchema);
