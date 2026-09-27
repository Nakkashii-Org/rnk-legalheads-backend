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

/** Internal note by a CMS user (never shown to the sender). Notes are only added, never edited. */
export const noteSchema = new Schema({ text: { type: String, required: true, maxlength: 2000 }, by: { type: String, required: true }, at: { type: Date, required: true } }, { _id: false });

/** Contact form submission (guide p.136). Handled in the CMS Enquiries inbox (phase E). */
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
    notes: { type: [noteSchema], default: [] },
    delivery: { type: deliverySchema, default: () => ({}) },
  },
  { timestamps: true },
);

export type EnquiryDoc = InferSchemaType<typeof enquirySchema>;
export const Enquiry = model("Enquiry", enquirySchema);
