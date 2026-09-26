import { Schema, model, type InferSchemaType } from "mongoose";
import { schemaOptions, slugField, workAreaSchema, workflowFields } from "./common.js";

export const SERVICE_GROUPS = ["business", "disputes", "tax", "property", "ip", "people", "regulated"] as const;

/** Service record (guide p.150): directory card plus the service page content. */
const serviceSchema = new Schema(
  {
    /** Stable id used by other records (e.g. "S10"); never changes when the slug does. */
    serviceId: { type: String, required: true, unique: true, match: /^S\d{2,3}$/ },
    slug: { ...slugField, unique: true },
    title: { type: String, required: true, maxlength: 120 },
    group: { type: String, enum: SERVICE_GROUPS, required: true },
    summary: { type: String, required: true, maxlength: 300 },
    overview: { type: String, default: "" },
    scope: { type: [workAreaSchema], default: [] },
    /** Related service ids, in display order. */
    related: { type: [String], default: [] },
    /** Publication hold: never public while set (e.g. Litigation Funding Advisory, guide p.63). */
    hold: { type: Boolean, default: false },
    /** Service register (internal, guide p.149). */
    owner: String,
    jurisdiction: String,
    ...workflowFields,
  },
  schemaOptions,
);

export type ServiceDoc = InferSchemaType<typeof serviceSchema>;
export const Service = model("Service", serviceSchema);
