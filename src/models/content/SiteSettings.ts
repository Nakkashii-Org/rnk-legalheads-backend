import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Firm facts used across the website (guide p.149). A single document (key "site"). Never holds
 * API keys, passwords or subscriber data.
 */
const siteSettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: "site" },
    name: { type: String, required: true },
    legalEntity: String,
    established: { type: Number, required: true },
    statement: { type: String, required: true },
    disclaimer: { type: String, required: true },
    /** Name or designation of the grievance / privacy contact shown in the Privacy Policy. */
    grievanceContact: String,
    contact: {
      address: String,
      phone: String,
      email: String,
      mapQuery: String,
    },
  },
  { timestamps: true, versionKey: false },
);

export type SiteSettingsDoc = InferSchemaType<typeof siteSettingsSchema>;
export const SiteSettings = model("SiteSettings", siteSettingsSchema);
