import { Schema } from "mongoose";

/**
 * Workflow status shared by every content type (plan section 6.1). Only "published" records are
 * public; the rest are visible only in draft review mode or, later, inside the CMS.
 */
export const CONTENT_STATUSES = ["draft", "in_review", "changes_requested", "approved", "published", "unpublished", "archived"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Fields every content document has. */
export const workflowFields = {
  status: { type: String, enum: CONTENT_STATUSES, default: "draft", index: true },
  /** Layout-preview record from the guide's mockups: shown only in draft review mode, never published. */
  preview: { type: Boolean, default: false },
  /** Set when a revision is published (filled by the publishing workflow, phase D). */
  publishedRevisionAt: Date,
  /** Email of the CMS user who created the record (absent for imported records). */
  createdBy: String,
  /** Email of the CMS user who saved it last. */
  updatedBy: String,
  /** Number of the latest saved revision (0 for imported records). */
  revision: { type: Number, default: 0 },
};

export const slugField = { type: String, required: true, match: SLUG, maxlength: 100 };

// Drafts may hold half-written work areas; "Send for review" requires both parts.
export const workAreaSchema = new Schema({ title: { type: String, default: "" }, text: { type: String, default: "" } }, { _id: false });

export const schemaOptions = { timestamps: true, versionKey: false } as const;
