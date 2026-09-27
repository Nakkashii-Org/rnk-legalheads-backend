import type { Request, Response } from "express";
import type { Model } from "mongoose";
import { Application } from "../models/Application.js";
import { CONTENT_STATUSES } from "../models/content/common.js";
import { Industry } from "../models/content/Industry.js";
import { Job } from "../models/content/Job.js";
import { Newsletter } from "../models/content/Newsletter.js";
import { Person } from "../models/content/Person.js";
import { Publication } from "../models/content/Publication.js";
import { Service } from "../models/content/Service.js";
import { Enquiry } from "../models/Enquiry.js";
import { Media } from "../models/Media.js";

type Rec = Record<string, any>;

/** CMS content types (the URL segment) → where they live and how a row is summarised. */
export const CONTENT_TYPES: Record<string, { model: Model<any>; filter: Rec; title: string; detail: (d: Rec) => string | undefined; author?: (d: Rec) => string | undefined }> = {
  articles: { model: Publication, filter: { type: "article" }, title: "title", detail: (d) => d.datePublished ?? "Not published", author: (d) => d.author?.name },
  judgments: { model: Publication, filter: { type: "judgment" }, title: "title", detail: (d) => d.court ?? d.datePublished, author: (d) => d.author?.name },
  "legal-updates": { model: Publication, filter: { type: "update" }, title: "title", detail: (d) => d.issuer ?? d.datePublished, author: (d) => d.author?.name },
  newsletters: { model: Newsletter, filter: {}, title: "title", detail: (d) => `${d.items?.length ?? 0} publications` },
  services: { model: Service, filter: {}, title: "title", detail: (d) => (d.hold ? `${d.serviceId} · Publication hold` : d.serviceId) },
  people: { model: Person, filter: {}, title: "name", detail: (d) => d.role },
  industries: { model: Industry, filter: {}, title: "name", detail: (d) => `${d.serviceIds?.length ?? 0} services` },
  jobs: { model: Job, filter: {}, title: "title", detail: (d) => (d.vacancyStatus === "closed" ? "Closed" : "Open") },
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const str = (v: unknown) => (typeof v === "string" ? v : "");

function row(type: string, d: Rec) {
  const t = CONTENT_TYPES[type]!;
  return {
    type,
    id: d.slug as string,
    title: d[t.title] as string,
    status: d.status as string,
    preview: Boolean(d.preview),
    /** A published copy is on the website (it may differ from the latest saved text). */
    live: Boolean(d.live?.data) || d.status === "published",
    detail: t.detail(d),
    author: t.author?.(d),
    updatedAt: d.updatedAt,
  };
}

/** Removes database internals before a record goes to the editor. */
function forEditor(d: Rec) {
  const { _id, createdAt, live, ...rest } = d;
  return rest;
}

/**
 * CMS read APIs (C1). Any signed-in user can read; saving and publishing arrive in C2 and D.
 * Returns every workflow status (including drafts): the website's public API never does.
 */
export class AdminContentController {
  /** GET /api/admin/content/:type?status=&q= */
  list = async (req: Request, res: Response) => {
    const type = String(req.params.type);
    const t = CONTENT_TYPES[type];
    if (!t) return void res.status(404).json({ error: "not_found" });
    const status = str(req.query.status);
    const q = str(req.query.q).trim().slice(0, 100);
    const filter: Rec = { ...t.filter };
    if ((CONTENT_STATUSES as readonly string[]).includes(status)) filter.status = status;
    if (q) filter.$or = [{ [t.title]: new RegExp(escapeRegex(q), "i") }, { slug: new RegExp(escapeRegex(q), "i") }];
    const [docs, total] = await Promise.all([
      t.model.find(filter).sort({ updatedAt: -1, _id: 1 }).lean<Rec[]>(),
      t.model.countDocuments(t.filter),
    ]);
    res.json({ items: docs.map((d) => row(type, d)), total });
  };

  /** GET /api/admin/content/:type/:id → the full record (id = slug). */
  one = async (req: Request, res: Response) => {
    const type = String(req.params.type);
    const t = CONTENT_TYPES[type];
    if (!t) return void res.status(404).json({ error: "not_found" });
    const doc = await t.model.findOne({ ...t.filter, slug: req.params.id }).lean<Rec>();
    if (!doc) return void res.status(404).json({ error: "not_found" });
    res.json({
      summary: row(type, doc),
      record: forEditor(doc),
      // Review and publishing state for the editor and the reviewer view (phase D).
      workflow: {
        revision: doc.revision ?? 0,
        createdBy: doc.createdBy,
        updatedBy: doc.updatedBy,
        approval: doc.approval?.revision ? doc.approval : undefined,
        live: doc.live?.data ? { revision: doc.live.revision, by: doc.live.by, at: doc.live.at } : doc.status === "published" ? {} : undefined,
        campaignId: doc.campaignId,
      },
    });
  };

  /** GET /api/admin/content?status= → matching records of every type (the review queue). */
  across = async (req: Request, res: Response) => {
    const status = str(req.query.status);
    if (!(CONTENT_STATUSES as readonly string[]).includes(status)) return void res.status(422).json({ error: "status_required" });
    const lists = await Promise.all(
      Object.entries(CONTENT_TYPES).map(async ([type, t]) =>
        (await t.model.find({ ...t.filter, status }).sort({ updatedAt: -1 }).lean<Rec[]>()).map((d) => row(type, d)),
      ),
    );
    res.json({ items: lists.flat() });
  };

  /** GET /api/admin/dashboard → real counts; inbox counts only for roles that may open the inbox. */
  dashboard = async (req: Request, res: Response) => {
    const counts: Record<string, number> = Object.fromEntries(CONTENT_STATUSES.map((s) => [s, 0]));
    let total = 0;
    const models = [...new Set(Object.values(CONTENT_TYPES).map((t) => t.model))];
    for (const model of models) {
      const grouped = await model.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
      for (const g of grouped) {
        counts[g._id] = (counts[g._id] ?? 0) + g.n;
        total += g.n;
      }
    }
    const newest = async (types: string[], status: string[], limit: number) =>
      (
        await Promise.all(
          types.map(async (type) => {
            const t = CONTENT_TYPES[type]!;
            return (await t.model.find({ ...t.filter, status: { $in: status } }).sort({ updatedAt: -1 }).limit(limit).lean<Rec[]>()).map((d) => row(type, d));
          }),
        )
      )
        .flat()
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, limit);

    // Publication drafts only (status exactly "draft"); review requests from every content type.
    const recent = await newest(["articles", "judgments", "legal-updates", "newsletters"], ["draft"], 6);
    const reviewRequests = await newest(Object.keys(CONTENT_TYPES), ["in_review", "changes_requested"], 10);

    const roles = req.user?.roles ?? [];
    const inboxAllowed = roles.includes("admin") || roles.includes("publisher");
    const inbox = inboxAllowed
      ? { enquiries: await Enquiry.countDocuments({ status: "new" }), applications: await Application.countDocuments({ status: "new" }) }
      : null;
    res.json({ counts, total, recentDrafts: recent, reviewRequests, inbox });
  };

  /** GET /api/admin/options → choices for the editors' pickers (every status, so drafts can be linked). */
  options = async (_req: Request, res: Response) => {
    const [services, people, publications, media] = await Promise.all([
      Service.find({ status: { $ne: "archived" } }, { serviceId: 1, title: 1 }).sort({ serviceId: 1 }).lean<Rec[]>(),
      Person.find({ status: { $ne: "archived" } }, { slug: 1, name: 1 }).sort({ name: 1 }).lean<Rec[]>(),
      Publication.find({ status: { $ne: "archived" } }, { type: 1, slug: 1, title: 1, status: 1 }).sort({ updatedAt: -1 }).lean<Rec[]>(),
      Media.find({}, { title: 1, url: 1, alt: 1, decorative: 1 }).sort({ createdAt: -1 }).limit(500).lean<Rec[]>(),
    ]);
    const label: Rec = { article: "Article", judgment: "Judgment note", update: "Legal update" };
    res.json({
      services: services.map((s) => ({ value: s.serviceId, label: s.title })),
      people: people.map((p) => ({ value: p.slug, label: p.name })),
      publications: publications.map((p) => ({ value: `${p.type}:${p.slug}`, label: `${label[p.type]}: ${p.title}`, status: p.status })),
      media: media.map((m) => ({ value: String(m._id), label: m.title, url: m.url, alt: m.alt, decorative: m.decorative })),
    });
  };
}
