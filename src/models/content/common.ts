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
};

export const slugField = { type: String, required: true, match: SLUG, maxlength: 100 };

export const workAreaSchema = new Schema({ title: { type: String, required: true }, text: { type: String, required: true } }, { _id: false });

export const schemaOptions = { timestamps: true, versionKey: false } as const;
