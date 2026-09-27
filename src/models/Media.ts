import { Schema, model, type InferSchemaType } from "mongoose";

export const LICENCES = ["own", "consent", "licensed", "original"] as const;

/** An image in the CMS media library (guide p.148): every asset records its source, licence and alt text. */
const mediaSchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 120 },
    /** Empty only when the image is decorative. */
    alt: { type: String, default: "", maxlength: 250 },
    decorative: { type: Boolean, default: false },
    credit: { type: String, required: true, maxlength: 160 },
    licence: { type: String, enum: LICENCES, required: true },
    /** Public address of the image (Cloudinary, or /api/media-files/… in development). */
    url: { type: String, required: true },
    /** Key in the image storage, used to delete it. */
    storageKey: { type: String, required: true },
    contentType: { type: String, required: true },
    bytes: { type: Number, required: true },
    width: Number,
    height: Number,
    uploadedBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

export type MediaDoc = InferSchemaType<typeof mediaSchema>;
export const Media = model("Media", mediaSchema);
