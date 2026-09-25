import { Schema, model, type InferSchemaType } from "mongoose";

export const deliverySchema = new Schema(
  {
    status: { type: String, enum: ["pending", "sent", "failed"], default: "pending" },
    messageId: String,
    /** Provider error code only; never the message body. */
    error: String,
    attemptedAt: Date,
  },
  { _id: false },
);

/** Contact form submission (guide p.136). Visible later in the CMS Enquiries inbox. */
const enquirySchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    name: { type: String, required: true, maxlength: 100 },
    email: { type: String, required: true, maxlength: 254 },
    phone: { type: String, maxlength: 30 },
    organisation: { type: String, maxlength: 150 },
    service: { type: String, required: true },
    message: { type: String, required: true, maxlength: 1500 },
    context: { kind: { type: String, enum: ["person", "industry"] }, slug: String },
    acknowledged: { type: Boolean, required: true },
    status: { type: String, enum: ["new", "in-progress", "closed"], default: "new", index: true },
    delivery: { type: deliverySchema, default: () => ({}) },
  },
  { timestamps: true },
);

export type EnquiryDoc = InferSchemaType<typeof enquirySchema>;
export const Enquiry = model("Enquiry", enquirySchema);
