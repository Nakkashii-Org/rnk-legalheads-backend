import { Schema, model, type InferSchemaType } from "mongoose";
import { schemaOptions, slugField, workAreaSchema, workflowFields } from "./common.js";

/** Industry / sector page (guide p.113–116, p.150). */
const industrySchema = new Schema(
  {
    slug: { ...slugField, unique: true },
    name: { type: String, required: true, maxlength: 120 },
    summary: { type: String, default: "", maxlength: 300 },
    serviceIds: { type: [String], default: [] },
    intro: String,
    overview: String,
    workAreas: { type: [workAreaSchema], default: undefined },
    /** Position among the six homepage sectors (1–6); unset = not featured. */
    homeOrder: Number,
    /** Lawyers for this sector (people slugs). */
    people: { type: [String], default: [] },
    ...workflowFields,
  },
  schemaOptions,
);

export type IndustryDoc = InferSchemaType<typeof industrySchema>;
export const Industry = model("Industry", industrySchema);
