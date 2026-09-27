import { Schema, model, type InferSchemaType } from "mongoose";
import { schemaOptions, slugField, workflowFields } from "./common.js";

/** Vacancy (guide p.137, p.150). */
const jobSchema = new Schema(
  {
    jobId: { type: String, unique: true, sparse: true, maxlength: 40 },
    slug: { ...slugField, unique: true },
    title: { type: String, required: true, maxlength: 120 },
    practice: { type: String, default: "" },
    location: { type: String, default: "" },
    workArrangement: { type: String, default: "" },
    experience: { type: String, default: "" },
    summary: { type: String, default: "", maxlength: 400 },
    responsibilities: { type: [String], default: [] },
    qualifications: { type: [String], default: [] },
    applicationInstructions: { type: String, default: "" },
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
