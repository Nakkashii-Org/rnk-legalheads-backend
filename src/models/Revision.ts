import { Schema, model } from "mongoose";

/**
 * A full copy of a content record as it was saved (plan section 8: "revisions"). Every save adds
 * one; they are never changed, so any earlier version can be shown or restored later.
 */
const revisionSchema = new Schema(
  {
    /** CMS content type, e.g. "articles", "services". */
    contentType: { type: String, required: true },
    recordId: { type: Schema.Types.ObjectId, required: true },
    number: { type: Number, required: true },
    /** What happened: created, saved, sent for review. */
    action: { type: String, required: true },
    status: { type: String, required: true },
    savedBy: { type: String, required: true },
    savedAt: { type: Date, required: true, default: () => new Date() },
    data: { type: Schema.Types.Mixed, required: true },
  },
  { versionKey: false },
);

revisionSchema.index({ contentType: 1, recordId: 1, number: -1 }, { unique: true });

export const Revision = model("Revision", revisionSchema);
