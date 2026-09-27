import { Schema, model } from "mongoose";

export const REVIEW_ACTIONS = ["approved", "changes_requested", "rejected", "published", "unpublished", "restored", "email_draft"] as const;

/** Review and publishing decisions on a record, with the reviewer's comment (phase D). Never changed afterwards. */
const reviewEventSchema = new Schema(
  {
    contentType: { type: String, required: true },
    recordId: { type: Schema.Types.ObjectId, required: true },
    /** The revision the decision applies to. */
    revision: { type: Number, required: true },
    action: { type: String, enum: REVIEW_ACTIONS, required: true },
    comment: { type: String, maxlength: 2000 },
    by: { type: String, required: true },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false },
);
reviewEventSchema.index({ contentType: 1, recordId: 1, at: -1 });

export const ReviewEvent = model("ReviewEvent", reviewEventSchema);
