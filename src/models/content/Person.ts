import { Schema, model, type InferSchemaType } from "mongoose";
import { schemaOptions, slugField, workflowFields } from "./common.js";

/** Lawyer profile (guide p.117–118, p.150). */
const personSchema = new Schema(
  {
    slug: { ...slugField, unique: true },
    name: { type: String, required: true, maxlength: 120 },
    role: { type: String, required: true, maxlength: 120 },
    practiceSummary: { type: String, required: true, maxlength: 300 },
    biography: { type: [String], default: [] },
    priorExperience: String,
    qualifications: String,
    enrolment: String,
    languages: String,
    office: String,
    serviceIds: { type: [String], default: [] },
    portrait: { src: String, alt: String },
    /** The lawyer agreed to the portrait being published (guide p.148). */
    portraitConsent: { type: Boolean, default: false },
    ...workflowFields,
  },
  schemaOptions,
);

export type PersonDoc = InferSchemaType<typeof personSchema>;
export const Person = model("Person", personSchema);
