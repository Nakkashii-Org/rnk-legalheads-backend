import { Schema, model, type InferSchemaType } from "mongoose";
import { schemaOptions, slugField, workflowFields } from "./common.js";

export const PUBLICATION_TYPES = ["article", "judgment", "update"] as const;

/**
 * Body blocks: headings, paragraphs and lists. `text`/`items` hold plain text; `rich`/`richItems`
 * add bold, italic and checked links as data (never HTML), so nothing needs sanitising on the website.
 */
const spanSchema = new Schema({ text: { type: String, required: true }, bold: Boolean, italic: Boolean, href: String }, { _id: false });

const bodyBlockSchema = new Schema(
  {
    kind: { type: String, enum: ["h2", "h3", "p", "ul", "ol"], required: true },
    text: String,
    items: { type: [String], default: undefined },
    rich: { type: [spanSchema], default: undefined },
    /** One list of runs per item (only when a list item has formatting). */
    richItems: { type: Schema.Types.Mixed, default: undefined },
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
    summary: { type: String, default: "", maxlength: 400 },
    author: { name: { type: String, default: "" }, personSlug: String },
    /** Content dates, ISO YYYY-MM-DD (separate from the record's createdAt/updatedAt). */
    datePublished: String,
    dateUpdated: String,
    serviceIds: { type: [String], default: [] },
    body: { type: [bodyBlockSchema], default: [] },
    sources: { type: [sourceSchema], default: [] },
    /** Optional image from the media library (sharing previews). */
    image: { src: String, alt: String, mediaId: String },

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

    seoTitle: { type: String, maxlength: 70 },
    seoDescription: { type: String, maxlength: 170 },

    ...workflowFields,
  },
  schemaOptions,
);

// The same slug may exist once per type (/articles/x and /legal-updates/x are different pages).
publicationSchema.index({ type: 1, slug: 1 }, { unique: true });

export type PublicationDoc = InferSchemaType<typeof publicationSchema>;
export const Publication = model("Publication", publicationSchema);
