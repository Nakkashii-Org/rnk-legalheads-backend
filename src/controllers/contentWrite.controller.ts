import type { Request, Response } from "express";
import { Industry } from "../models/content/Industry.js";
import { Newsletter } from "../models/content/Newsletter.js";
import { Person } from "../models/content/Person.js";
import { Publication } from "../models/content/Publication.js";
import { Service } from "../models/content/Service.js";
import { Revision } from "../models/Revision.js";
import { audit } from "../services/auth.js";
import { loadBundle } from "../services/content.js";
import { draftProblems, reviewProblems, type FieldErrors } from "../services/contentWrite.js";
import { CONTENT_TYPES } from "./adminContent.controller.js";

type Rec = Record<string, any>;

/** Records in these states can't be edited yet: editing live content arrives with publishing (phase D). */
const LOCKED = ["approved", "published", "unpublished", "archived"];

const valuesFrom = (req: Request): Rec => {
  const v = (req.body as { values?: unknown } | undefined)?.values;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
};

async function nextServiceId(): Promise<string> {
  const ids = await Service.find({}, { serviceId: 1 }).lean<{ serviceId: string }[]>();
  const max = ids.reduce((m, s) => Math.max(m, Number(s.serviceId.slice(1)) || 0), 0);
  return `S${String(max + 1).padStart(2, "0")}`;
}

/**
 * Creating and saving content (C2). Every signed-in role may write drafts (plan section 6.2);
 * every save keeps a full revision. Approving and publishing come in phase D.
 */
export class ContentWriteController {
  private async slugTaken(type: string, slug: string, exceptId?: unknown) {
    const t = CONTENT_TYPES[type]!;
    return Boolean(await t.model.exists({ ...t.filter, slug, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }));
  }

  private async keepRevision(type: string, record: Rec, action: string, by: string) {
    await Revision.create({ contentType: type, recordId: record._id, number: record.revision, action, status: record.status, savedBy: by, data: record.toObject() });
  }

  /** Shared by Save draft and Send for review. Returns the saved record, or answers with the error. */
  private async save(req: Request, res: Response, action: "saved" | "sent for review"): Promise<Rec | undefined> {
    const type = String(req.params.type);
    const t = CONTENT_TYPES[type];
    if (!t) return void res.status(404).json({ error: "not_found" });
    const record = await t.model.findOne({ ...t.filter, slug: req.params.id });
    if (!record) return void res.status(404).json({ error: "not_found" });
    if (LOCKED.includes(record.status))
      return void res.status(409).json({ error: "locked", message: "Approved and published records can't be edited yet. Editing live content arrives with publishing." });

    const values = valuesFrom(req);
    const { doc, errors } = await draftProblems(type, values);
    if (!errors.slug && doc.slug !== record.slug && (await this.slugTaken(type, String(doc.slug), record._id)))
      errors.slug = "This URL slug is already used. Choose another.";
    if (type === "jobs" && doc.jobId && (await t.model.exists({ jobId: doc.jobId, _id: { $ne: record._id } }))) errors.jobId = "This job ID is already used.";
    if (action === "sent for review") Object.assign(errors, reviewProblems(type, values), errors);
    if (Object.keys(errors).length) return void res.status(422).json({ errors: errors as FieldErrors });

    // Imported fields the editor doesn't show (homeOrder, preview flags…) are kept.
    record.set(doc);
    if (t.filter.type === "judgment" || t.filter.type === "update")
      record.set("sourceCheckedAt", values.sourceChecked === true ? (record.sourceCheckedAt ?? new Date().toISOString().slice(0, 10)) : undefined);
    const withdrawn = record.status === "in_review" && action === "saved";
    record.status = action === "sent for review" ? "in_review" : record.status === "changes_requested" ? "changes_requested" : "draft";
    record.updatedBy = req.user!.email;
    record.revision = (record.revision ?? 0) + 1;
    await record.save();
    await this.keepRevision(type, record, action, req.user!.email);
    await audit(action === "saved" ? "content.saved" : "content.sent_for_review", {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      target: `${type}/${record.slug}`,
      detail: `revision ${record.revision}${withdrawn ? "; withdrawn from review by the edit" : ""}`,
    });
    return record;
  }

  /** POST /api/admin/content/:type { values } → a new draft (revision 1). */
  create = async (req: Request, res: Response) => {
    const type = String(req.params.type);
    const t = CONTENT_TYPES[type];
    if (!t) return void res.status(404).json({ error: "not_found" });
    const values = valuesFrom(req);
    const { doc, errors } = await draftProblems(type, values);
    if (!errors.slug && (await this.slugTaken(type, String(doc.slug)))) errors.slug = "This URL slug is already used. Choose another.";
    if (type === "jobs" && doc.jobId && (await t.model.exists({ jobId: doc.jobId }))) errors.jobId = "This job ID is already used.";
    if (Object.keys(errors).length) return void res.status(422).json({ errors });

    const extra: Rec = type === "services" ? { serviceId: await nextServiceId() } : {};
    if (t.filter.type === "judgment" || t.filter.type === "update") extra.sourceCheckedAt = values.sourceChecked === true ? new Date().toISOString().slice(0, 10) : undefined;
    const record = await t.model.create({ ...doc, ...t.filter, ...extra, status: "draft", createdBy: req.user!.email, updatedBy: req.user!.email, revision: 1 });
    await this.keepRevision(type, record, "created", req.user!.email);
    await audit("content.created", { actorId: req.user!.id, actorEmail: req.user!.email, target: `${type}/${record.slug}` });
    res.status(201).json({ id: record.slug, status: record.status, revision: record.revision });
  };

  /** PATCH /api/admin/content/:type/:id { values } → Save draft. Editing an in-review record takes it back to draft. */
  update = async (req: Request, res: Response) => {
    const record = await this.save(req, res, "saved");
    if (record) res.json({ id: record.slug, status: record.status, revision: record.revision });
  };

  /** POST /api/admin/content/:type/:id/submit { values } → saves, runs every review check, then In review. */
  submit = async (req: Request, res: Response) => {
    const type = String(req.params.type);
    const t = CONTENT_TYPES[type];
    const current = t ? await t.model.findOne({ ...t.filter, slug: req.params.id }, { status: 1 }).lean<Rec>() : null;
    if (current?.status === "in_review") return void res.status(409).json({ error: "already_in_review", message: "This record is already waiting for review." });
    const record = await this.save(req, res, "sent for review");
    if (record) res.json({ id: record.slug, status: record.status, revision: record.revision });
  };

  /** DELETE /api/admin/content/:type/:id → only never-published drafts nothing links to; by their creator or an Administrator. */
  remove = async (req: Request, res: Response) => {
    const type = String(req.params.type);
    const t = CONTENT_TYPES[type];
    if (!t) return void res.status(404).json({ error: "not_found" });
    const record = await t.model.findOne({ ...t.filter, slug: req.params.id });
    if (!record) return void res.status(404).json({ error: "not_found" });
    if (!req.user!.roles.includes("admin") && record.createdBy !== req.user!.email)
      return void res.status(403).json({ error: "forbidden", message: "Only the person who created this draft, or an Administrator, can delete it." });
    if (!["draft", "changes_requested"].includes(record.status) || record.publishedRevisionAt)
      return void res.status(409).json({ error: "not_a_draft", message: "Only drafts that were never published can be deleted." });

    // Never leave broken links behind (plan section 8).
    let usedBy = 0;
    if (type === "services") {
      const id = record.serviceId;
      usedBy =
        (await Service.countDocuments({ related: id })) +
        (await Industry.countDocuments({ serviceIds: id })) +
        (await Person.countDocuments({ serviceIds: id })) +
        (await Publication.countDocuments({ serviceIds: id }));
    } else if (type === "people") {
      usedBy =
        (await Publication.countDocuments({ "author.personSlug": record.slug })) +
        (await Service.countDocuments({ people: record.slug })) +
        (await Industry.countDocuments({ people: record.slug }));
    } else if (t.filter.type) {
      usedBy = await Newsletter.countDocuments({ items: { $elemMatch: { type: t.filter.type, slug: record.slug } } });
    }
    if (usedBy > 0)
      return void res.status(409).json({ error: "in_use", message: `This draft is linked from ${usedBy} other record${usedBy === 1 ? "" : "s"}. Remove those links first.` });

    await record.deleteOne();
    await audit("content.deleted", { actorId: req.user!.id, actorEmail: req.user!.email, target: `${type}/${record.slug}` });
    res.json({ ok: true });
  };

  /** GET /api/admin/content/:type/:id/revisions → saved versions, newest first. */
  revisions = async (req: Request, res: Response) => {
    const type = String(req.params.type);
    const t = CONTENT_TYPES[type];
    if (!t) return void res.status(404).json({ error: "not_found" });
    const record = await t.model.findOne({ ...t.filter, slug: req.params.id }, { _id: 1 }).lean<Rec>();
    if (!record) return void res.status(404).json({ error: "not_found" });
    const list = await Revision.find({ contentType: type, recordId: record._id }, { data: 0 }).sort({ number: -1 }).limit(50).lean<Rec[]>();
    res.json({ revisions: list.map((r) => ({ number: r.number, action: r.action, status: r.status, savedBy: r.savedBy, savedAt: r.savedAt })) });
  };

  /** GET /api/admin/preview-bundle → the website's content including drafts, for signed-in staff previews. */
  previewBundle = async (_req: Request, res: Response) => {
    res.set("Cache-Control", "private, no-store");
    res.json(await loadBundle(true));
  };
}
