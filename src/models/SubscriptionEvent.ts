import { Schema, model } from "mongoose";

/**
 * Append-only history of newsletter consent (guide p.130, p.139): who asked for what, and when.
 * Brevo stays the source of truth for current topics; this is the audit trail. Records are never
 * updated or deleted by the application.
 */
const subscriptionEventSchema = new Schema(
  {
    email: { type: String, required: true, index: true },
    action: {
      type: String,
      enum: ["subscribe_requested", "confirmed", "preferences_updated", "unsubscribed", "bounced", "complained"],
      required: true,
    },
    /** Topics after this action (empty after unsubscribing). */
    topics: { type: [String], default: undefined },
    /** Where the event came from: the website (default) or Brevo (webhook: unsubscribe link in a campaign, bounce, spam complaint). */
    source: { type: String, enum: ["website", "brevo"], default: "website" },
    /** Privacy-notice version shown when consent was given (subscribe only). */
    noticeVersion: String,
    at: { type: Date, required: true, default: () => new Date(), index: true },
  },
  { versionKey: false },
);

export const SubscriptionEvent = model("SubscriptionEvent", subscriptionEventSchema);
