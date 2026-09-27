import type { Request, Response } from "express";
import type { Model } from "mongoose";
import { logger } from "../lib/logger.js";
import { Application } from "../models/Application.js";
import { Enquiry } from "../models/Enquiry.js";
import { audit } from "../services/auth.js";
import type { Deps } from "../types.js";

type Rec = Record<string, any>;

const PAGE_SIZE = 50;
const REFERENCE = /^RNK-[A-Z0-9]{8}$/;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const str = (v: unknown, max = 100) => (typeof v === "string" ? v.trim().slice(0, max) : "");

type Kind = {
  model: Model<any>;
  noun: string;
  statuses: string[];
  /** Fields searched by ?q= */
  search: string[];
  /** List row: the few fields the table shows. */
  row: (d: Rec) => Rec;
};

const KINDS: Record<"enquiries" | "applications", Kind> = {
  enquiries: {
    model: Enquiry,
    noun: "enquiry",
    statuses: ["new", "in-progress", "closed"],
    search: ["reference", "name", "email", "organisation"],
    row: (d) => ({ reference: d.reference, receivedAt: d.createdAt, name: d.name, email: d.email, service: d.service, status: d.status, emailed: d.delivery?.status }),
  },
  applications: {
    model: Application,
    noun: "application",
    statuses: ["new", "shortlisted", "rejected"],
    search: ["reference", "name", "email", "city"],
    row: (d) => ({
      reference: d.reference,
      receivedAt: d.createdAt,
      name: d.name,
      email: d.email,
      position: d.position,
      experience: d.experience,
      resume: d.resume ? { name: d.resume.originalName, size: d.resume.size, type: d.resume.mimeType } : undefined,
      status: d.status,
      emailed: d.delivery?.status,
    }),
  },
};

/** The full record for the detail page, without database internals or the storage key. */
function detail(d: Rec) {
  const { _id, __v, resume, delivery, ...rest } = d;
  return {
    ...rest,
    receivedAt: d.createdAt,
    emailed: delivery?.status,
    resume: resume ? { name: resume.originalName, size: resume.size, type: resume.mimeType } : undefined,
  };
}

/**
 * The inbox (phase E): contact enquiries and job applications, for Publishers and Administrators
 * (the routes check the role). Personal data: every change, resume download and deletion is audited.
 */
export class InboxController {
  constructor(private readonly deps: Deps) {}

  private kind(req: Request) {
    return KINDS[String(req.params.kind) as keyof typeof KINDS];
  }

  private async find(req: Request, res: Response) {
    const kind = this.kind(req);
    const reference = String(req.params.reference);
    if (!kind || !REFERENCE.test(reference)) return void res.status(404).json({ error: "not_found" });
    const record = await kind.model.findOne({ reference });
    if (!record) return void res.status(404).json({ error: "not_found" });
    return { kind, record };
  }

  /** GET /api/admin/inbox/:kind?status=&position=&q=&page= → newest first, with counts per status. */
  list = async (req: Request, res: Response) => {
    const kind = this.kind(req);
    if (!kind) return void res.status(404).json({ error: "not_found" });
    const filter: Rec = {};
    const status = str(req.query.status, 20);
    if (kind.statuses.includes(status)) filter.status = status;
    const position = str(req.query.position, 100);
    if (position && kind.model === Application) filter.position = position;
    const q = str(req.query.q);
    if (q) filter.$or = kind.search.map((f) => ({ [f]: { $regex: escapeRegex(q), $options: "i" } }));
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));

    const [items, total, grouped] = await Promise.all([
      kind.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean<Rec[]>(),
      kind.model.countDocuments(filter),
      kind.model.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const counts = Object.fromEntries(kind.statuses.map((s) => [s, grouped.find((g) => g._id === s)?.n ?? 0]));
    const positions = kind.model === Application ? ((await Application.distinct("position")) as string[]).sort() : undefined;
    res.json({ items: items.map(kind.row), total, page, pageSize: PAGE_SIZE, counts, positions });
  };

  /** GET /api/admin/inbox/:kind/:reference → the full enquiry or application, with internal notes. */
  one = async (req: Request, res: Response) => {
    const found = await this.find(req, res);
    if (!found) return;
    res.json({ item: detail(found.record.toObject()) });
  };

  /** PATCH /api/admin/inbox/:kind/:reference { status?, note? } → status change and/or a new internal note. */
  update = async (req: Request, res: Response) => {
    const found = await this.find(req, res);
    if (!found) return;
    const { kind, record } = found;
    const status = str(req.body?.status, 20);
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    const errors: Record<string, string> = {};
    if (status && !kind.statuses.includes(status)) errors.status = "Choose a status from the list.";
    if (note.length > 2000) errors.note = "Keep the note under 2,000 characters.";
    if (!status && !note) errors.note = "Change the status or write a note.";
    if (Object.keys(errors).length) return void res.status(422).json({ errors });

    const changes: string[] = [];
    if (status && status !== record.status) {
      changes.push(`status ${record.status} → ${status}`);
      record.status = status;
    }
    if (note) {
      record.notes.push({ text: note, by: req.user!.email, at: new Date() });
      changes.push("note added");
    }
    await record.save();
    if (changes.length)
      await audit(`${kind.noun}.updated`, { actorId: req.user!.id, actorEmail: req.user!.email, target: `${kind.noun}/${record.reference}`, detail: changes.join("; ") });
    res.json({ item: detail(record.toObject()) });
  };

  /** DELETE /api/admin/inbox/:kind/:reference → Administrators only (retention); an application's resume is deleted too. */
  remove = async (req: Request, res: Response) => {
    const found = await this.find(req, res);
    if (!found) return;
    const { kind, record } = found;
    if (record.resume?.key) {
      try {
        await this.deps.storage.remove(record.resume.key);
      } catch (error) {
        logger.error("inbox.resume_delete_failed", { reference: record.reference, error: (error as Error).message });
        return void res.status(502).json({ error: "storage_failed", message: "The resume could not be deleted from storage, so nothing was deleted. Please try again." });
      }
    }
    await record.deleteOne();
    await audit(`${kind.noun}.deleted`, { actorId: req.user!.id, actorEmail: req.user!.email, target: `${kind.noun}/${record.reference}` });
    res.json({ ok: true });
  };

  /**
   * GET /api/admin/inbox/applications/:reference/resume → the file itself, after the sign-in and role
   * check. There is no public or long-lived link to a resume.
   */
  resume = async (req: Request, res: Response) => {
    const found = await this.find(req, res);
    if (!found) return;
    const { record } = found;
    if (found.kind.model !== Application || !record.resume?.key) return void res.status(404).json({ error: "not_found" });
    if (record.resume.storage !== this.deps.config.storage.driver)
      return void res.status(409).json({ error: "other_storage", message: `This resume is stored in "${record.resume.storage}" storage, which this server isn't using.` });
    let body: Buffer;
    try {
      body = await this.deps.storage.get(record.resume.key);
    } catch (error) {
      logger.error("inbox.resume_download_failed", { reference: record.reference, error: (error as Error).message });
      return void res.status(502).json({ error: "storage_failed", message: "The resume couldn't be fetched from storage. Please try again." });
    }
    await audit("application.resume_downloaded", { actorId: req.user!.id, actorEmail: req.user!.email, target: `application/${record.reference}` });
    const ext = record.resume.key.slice(record.resume.key.lastIndexOf("."));
    const safeName = `${record.reference}-${String(record.name).replace(/[^A-Za-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "resume"}${ext}`;
    res.set({
      "Content-Type": record.resume.mimeType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(body);
  };
}
