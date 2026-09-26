import { Schema, model, type InferSchemaType } from "mongoose";
import { schemaOptions, slugField, workflowFields } from "./common.js";

export const PUBLICATION_TYPES = ["article", "judgment", "update"] as const;

/**
 * Body blocks: headings, paragraphs and lists as plain text, so nothing needs HTML sanitising on
 * the website. The CMS editor (phase C) converts its rich text into these blocks.
 */
const bodyBlockSchema = new Schema(
  {
    kind: { type: String, enum: ["h2", "h3", "p", "ul"], required: true },
    text: String,
    items: { type: [String], default: undefined },
  },
  { _id: false },
);

const sourceSchema = new Schema({ label: { type: String, required: true }, url: String }, { _id: false });

/**
 * Articles, judgment notes and legal updates in one collection (guide p.150: publication base
 * plus judgment and legal-update extensions).
 */
const publicationSchema = new Schema(
  {
    type: { type: String, enum: PUBLICATION_TYPES, required: true },
    slug: slugField,
    title: { type: String, required: true, maxlength: 200 },
    summary: { type: String, required: true, maxlength: 400 },
    author: { name: { type: String, required: true }, personSlug: String },
    /** Content dates, ISO YYYY-MM-DD (separate from the record's createdAt/updatedAt). */
    datePublished: String,
    dateUpdated: String,
    serviceIds: { type: [String], default: [] },
    body: { type: [bodyBlockSchema], default: [] },
    sources: { type: [sourceSchema], default: [] },

    // Judgment note
    caseName: String,
    court: String,
    caseNumber: String,
    neutralCitation: String,
    decisionDate: String,
    proceduralStatus: String,

    // Legal update
    issuer: String,
    instrument: String,
    instrumentStatus: { type: String, enum: ["proposed", "notified", "in-force"] },
    instrumentPublishedOn: String,
    effectiveDate: String,
    updateNotes: { type: [{ date: String, note: String, _id: false }], default: undefined },

    // Judgment and legal update
    officialSourceUrl: String,
    sourceCheckedAt: String,

    ...workflowFields,
  },
  schemaOptions,
);

// The same slug may exist once per type (/articles/x and /legal-updates/x are different pages).
publicationSchema.index({ type: 1, slug: 1 }, { unique: true });

export type PublicationDoc = InferSchemaType<typeof publicationSchema>;
export const Publication = model("Publication", publicationSchema);
