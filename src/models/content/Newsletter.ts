import { Schema, model, type InferSchemaType } from "mongoose";
import { schemaOptions, slugField, workflowFields } from "./common.js";
import { PUBLICATION_TYPES } from "./Publication.js";

// A path named "type" must live in its own Schema, or Mongoose reads it as the type declaration.
const itemSchema = new Schema(
  { type: { type: String, enum: PUBLICATION_TYPES, required: true }, slug: { type: String, required: true } },
  { _id: false },
);

/** Newsletter web issue (guide p.145, p.150). Publishing it never sends email. */
const newsletterSchema = new Schema(
  {
    slug: { ...slugField, unique: true },
    title: { type: String, required: true, maxlength: 160 },
    focus: { type: String, default: "" },
    /** ISO date, assigned only to approved issues. */
    issueDate: String,
    introduction: { type: String, default: "", maxlength: 1000 },
    contents: { type: [String], default: [] },
    /** Ordered references to publications. */
    items: { type: [itemSchema], default: [] },
    /** Brevo campaign created from this issue (phase D3). */
    campaignId: String,
    ...workflowFields,
  },
  schemaOptions,
);

export type NewsletterDoc = InferSchemaType<typeof newsletterSchema>;
export const Newsletter = model("Newsletter", newsletterSchema);
