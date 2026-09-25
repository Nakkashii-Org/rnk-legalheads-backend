import { Schema, model, type InferSchemaType } from "mongoose";
import { deliverySchema } from "./Enquiry.js";

/**
 * Job application. The resume lives in private storage; only its key and metadata are kept here.
 * Visible later in the CMS Applications inbox.
 */
const applicationSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    name: { type: String, required: true, maxlength: 100 },
    email: { type: String, required: true, maxlength: 254 },
    phone: { type: String, required: true, maxlength: 30 },
    city: { type: String, required: true, maxlength: 100 },
    position: { type: String, required: true, index: true },
    experience: { type: String, required: true },
    qualification: { type: String, required: true, maxlength: 150 },
    barEnrolment: { type: String, maxlength: 50 },
    organisation: { type: String, maxlength: 150 },
    linkedin: { type: String, maxlength: 300 },
    coverNote: { type: String, maxlength: 1500 },
    consent: { type: Boolean, required: true },
    resume: {
      /** Where the file lives: cloudinary (raw, authenticated), s3 (private bucket) or local (dev). */
      storage: { type: String, enum: ["cloudinary", "s3", "local"], required: true },
      key: { type: String, required: true },
      originalName: { type: String, required: true },
      mimeType: { type: String, required: true },
      size: { type: Number, required: true },
      sha256: { type: String, required: true },
    },
    status: { type: String, enum: ["new", "shortlisted", "rejected"], default: "new", index: true },
    delivery: { type: deliverySchema, default: () => ({}) },
  },
  { timestamps: true },
);

export type ApplicationDoc = InferSchemaType<typeof applicationSchema>;
export const Application = model("Application", applicationSchema);
