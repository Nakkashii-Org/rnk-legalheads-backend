import { Schema, model, type InferSchemaType } from "mongoose";
import { schemaOptions, slugField, workflowFields } from "./common.js";

/** Vacancy (guide p.137, p.150). */
const jobSchema = new Schema(
  {
    jobId: { type: String, required: true, unique: true, maxlength: 40 },
    slug: { ...slugField, unique: true },
    title: { type: String, required: true, maxlength: 120 },
    practice: { type: String, required: true },
    location: { type: String, required: true },
    workArrangement: { type: String, required: true },
    experience: { type: String, required: true },
    summary: { type: String, required: true, maxlength: 400 },
    responsibilities: { type: [String], default: [] },
    qualifications: { type: [String], default: [] },
    applicationInstructions: { type: String, required: true },
    applicationEmail: String,
    /** ISO dates (YYYY-MM-DD). */
    openedOn: String,
    closesOn: String,
    /** Open or closed vacancy (separate from the publishing status). */
    vacancyStatus: { type: String, enum: ["open", "closed"], default: "open" },
    ...workflowFields,
  },
  schemaOptions,
);

export type JobDoc = InferSchemaType<typeof jobSchema>;
export const Job = model("Job", jobSchema);
