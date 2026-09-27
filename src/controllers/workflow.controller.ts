import type { Request, Response } from "express";
import { logger } from "../lib/logger.js";
import { Newsletter } from "../models/content/Newsletter.js";
import { Person } from "../models/content/Person.js";
import { Publication } from "../models/content/Publication.js";
import { ReviewEvent, type REVIEW_ACTIONS } from "../models/ReviewEvent.js";
import { audit } from "../services/auth.js";
import { newsletterCampaignHtml } from "../services/templates.js";
import type { Deps } from "../types.js";
import { CONTENT_TYPES } from "./adminContent.controller.js";

type Rec = Record<string, any>;
type Role = "contributor" | "reviewer" | "publisher" | "admin";

export const CHECKLIST_LENGTH = 6;
const today = () => new Date().toISOString().slice(0, 10);
const comment = (req: Request) => (typeof req.body?.comment === "string" ? req.body.comment.trim().slice(0, 2000) : "");

/** Everything except workflow bookkeeping: the content as the website will show it. */
function snapshot(record: Rec): Rec {
  const { _id, live, approval, status, createdAt, updatedAt, createdBy, updatedBy, revision, publishedRevisionAt, campaignId, ...data } = record.toObject();
  return data;
}

/** A live filter for records published with a copy, or marked published before copies were kept. */
const liveWith = (path: string, value: unknown): Rec => ({ $or: [{ [`live.data.${path}`]: value }, { status: "published", [path]: value }] });

/**
 * Review and publishing (phase D). Legal reviewers approve, request changes or reject; publishers
 * publish and unpublish. Approval covers one exact revision; publishing copies it to the website.
 */
export class WorkflowController {
  constructor(private readonly deps: Deps) {}

  /** Loads the record and checks the role; answers the request itself when something is wrong. */
  private async load(req: Request, res: Response, roles: Role[]) {
    const type = String(req.params.type);
    const t = CONTENT_TYPES[type];
    if (!t) return void res.status(404).json({ error: "not_found" });
    if (!req.user!.roles.some((r) => roles.includes(r as Role)))
      return void res.status(403).json({ error: "forbidden", message: "Your role can't do this." });
    const record = await t.model.findOne({ ...t.filter, slug: req.params.id });
    if (!record) return void res.status(404).json({ error: "not_found" });
    return { type, record };
  }

  private async record(type: string, record: Rec, req: Request, action: (typeof REVIEW_ACTIONS)[number], text?: string) {
    await ReviewEvent.create({ contentType: type, recordId: record._id, revision: record.revision ?? 0, action, comment: text || undefined, by: req.user!.email });
    await audit(`content.${action}`, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      target: `${type}/${record.slug}`,
      detail: `revision ${record.revision ?? 0}${text ? `: ${text.slice(0, 200)}` : ""}`,
    });
  }

  private reply(res: Response, record: Rec) {
    res.json({ id: record.slug, status: record.status, revision: record.revision ?? 0, live: Boolean(record.live?.data) });
  }

  /** POST …/approve { checklist: [6 × true], comment? } → Approved (this exact revision). */
  approve = async (req: Request, res: Response) => {
    const found = await this.load(req, res, ["reviewer", "admin"]);
    if (!found) return;
    const { type, record } = found;
    if (record.status !== "in_review") return void res.status(409).json({ error: "not_in_review", message: "Only records in review can be approved." });
    const list = req.body?.checklist;
    if (!Array.isArray(list) || list.length !== CHECKLIST_LENGTH || !list.every((v) => v === true))
      return void res.status(422).json({ errors: { checklist: "Tick every checklist item to approve." } });
    // Four eyes: nobody approves their own changes, unless they are an Administrator (small teams).
    if (record.updatedBy === req.user!.email && !req.user!.roles.includes("admin"))
      return void res.status(403).json({ error: "own_revision", message: "You saved this revision, so another legal reviewer must approve it." });
    record.status = "approved";
    record.set("approval", { revision: record.revision ?? 0, by: req.user!.email, at: new Date() });
    await record.save();
    await this.record(type, record, req, "approved", comment(req));
    this.reply(res, record);
  };

  /** POST …/request-changes { comment } → Changes requested (back to the writer). */
  requestChanges = async (req: Request, res: Response) => {
    const found = await this.load(req, res, ["reviewer", "admin"]);
    if (!found) return;
    const { type, record } = found;
    if (record.status !== "in_review") return void res.status(409).json({ error: "not_in_review", message: "Only records in review can be sent back." });
    const text = comment(req);
    if (text.length < 10) return void res.status(422).json({ errors: { comment: "Add a comment of at least 10 characters so the author knows what to change." } });
    record.status = "changes_requested";
    await record.save();
    await this.record(type, record, req, "changes_requested", text);
    this.reply(res, record);
  };

  /**
   * POST …/reject { comment } → a never-published record is archived. For a published record only
   * the new edits are rejected: it goes back to Draft and the website keeps the live version.
   */
  reject = async (req: Request, res: Response) => {
    const found = await this.load(req, res, ["reviewer", "admin"]);
    if (!found) return;
    const { type, record } = found;
    if (record.status !== "in_review") return void res.status(409).json({ error: "not_in_review", message: "Only records in review can be rejected." });
    const text = comment(req);
    if (text.length < 10) return void res.status(422).json({ errors: { comment: "Add a comment of at least 10 characters explaining the rejection." } });
    record.status = record.live?.data ? "draft" : "archived";
    await record.save();
    await this.record(type, record, req, "rejected", text);
    this.reply(res, record);
  };

  /** POST …/restore → an archived record becomes a draft again (its creator or an Administrator). */
  restore = async (req: Request, res: Response) => {
    const found = await this.load(req, res, ["contributor", "reviewer", "publisher", "admin"]);
    if (!found) return;
    const { type, record } = found;
    if (record.status !== "archived") return void res.status(409).json({ error: "not_archived", message: "Only archived records can be restored." });
    if (!req.user!.roles.includes("admin") && record.createdBy !== req.user!.email)
      return void res.status(403).json({ error: "forbidden", message: "Only the person who created this record, or an Administrator, can restore it." });
    record.status = "draft";
    await record.save();
    await this.record(type, record, req, "restored");
    this.reply(res, record);
  };

  /** Links a published record needs to be live first, so the website never links to a missing page. */
  private async publishProblems(type: string, record: Rec): Promise<string | undefined> {
    if (["articles", "judgments", "legal-updates"].includes(type)) {
      const slug = record.author?.personSlug;
      if (!slug) return "Choose an author before publishing.";
      if (!(await Person.exists({ slug, ...liveWith("slug", slug) })))
        return `The author's profile (${record.author?.name || slug}) isn't published yet. Publish the profile first.`;
    }
    if (type === "newsletters") {
      const items: { type: string; slug: string }[] = record.items ?? [];
      if (!items.length) return "Add at least one publication before publishing the issue.";
      for (const i of items) {
        const filter: Rec = { type: i.type, slug: i.slug, ...liveWith("slug", i.slug) };
        if (!(await Publication.exists(filter)))
          return `"${i.slug}" in this issue isn't published yet. Publish it first, or remove it from the issue.`;
      }
    }
    return undefined;
  }

  /** POST …/publish → the approved revision goes live; the website shows it at once. */
  publish = async (req: Request, res: Response) => {
    const found = await this.load(req, res, ["publisher", "admin"]);
    if (!found) return;
    const { type, record } = found;
    const approvedNow = record.approval?.revision === (record.revision ?? 0);
    if (!["approved", "unpublished"].includes(record.status) || !approvedNow)
      return void res.status(409).json({ error: "not_approved", message: "Only an approved revision can be published. Send it for review first." });
    const problem = await this.publishProblems(type, record);
    if (problem) return void res.status(409).json({ error: "blocked", message: problem });

    // Dates the website shows are set by publishing, never typed in (guide p.2).
    if (record.schema.path("datePublished")) {
      if (!record.datePublished) record.datePublished = today();
      else if (record.live?.data || record.publishedRevisionAt) record.dateUpdated = today();
    }
    if (type === "newsletters" && !record.issueDate) record.issueDate = today();
    if (type === "jobs" && !record.openedOn) record.openedOn = today();

    // A reviewed, approved and published record is real content, no longer a layout placeholder.
    record.preview = false;
    const now = new Date();
    record.status = "published";
    record.publishedRevisionAt = now;
    record.set("live", { data: snapshot(record), revision: record.revision ?? 0, by: req.user!.email, at: now });
    await record.save();
    await this.record(type, record, req, "published");
    this.reply(res, record);
  };

  /** POST …/unpublish → off the website (listings, search, sitemap); the text stays in the CMS. */
  unpublish = async (req: Request, res: Response) => {
    const found = await this.load(req, res, ["publisher", "admin"]);
    if (!found) return;
    const { type, record } = found;
    if (!record.live?.data && record.status !== "published") return void res.status(409).json({ error: "not_live", message: "This record isn't on the website." });

    let usedBy = 0;
    if (type === "people") usedBy = await Publication.countDocuments(liveWith("author.personSlug", record.slug));
    else if (["articles", "judgments", "legal-updates"].includes(type))
      usedBy = await Newsletter.countDocuments(liveWith("items", { $elemMatch: { type: record.type, slug: record.slug } }));
    if (usedBy)
      return void res.status(409).json({
        error: "in_use",
        message: `${usedBy} published ${type === "people" ? "publication(s) name this lawyer as author" : "newsletter issue(s) include this"}. Unpublish or change those first.`,
      });

    record.set("live", undefined);
    if (record.status === "published") record.status = "unpublished";
    await record.save();
    await this.record(type, record, req, "unpublished");
    this.reply(res, record);
  };

  /** POST /api/admin/content/newsletters/:id/email-draft → a draft campaign in Brevo. Nothing is sent. */
  emailDraft = async (req: Request, res: Response) => {
    const found = await this.load(req, res, ["publisher", "admin"]);
    if (!found) return;
    const { type, record } = found;
    const live = record.live?.data ?? (record.status === "published" ? record.toObject() : undefined);
    if (!live) return void res.status(409).json({ error: "not_live", message: "Publish the issue on the website first, then create the email draft." });
    if (record.campaignId)
      return void res.status(409).json({ error: "exists", message: `An email draft already exists in Brevo (campaign ${record.campaignId}). Edit or send it there.` });

    const refs: { type: string; slug: string }[] = live.items ?? [];
    const byRef: Rec = { $or: refs.map((i) => ({ type: i.type, slug: i.slug })) };
    const pubs = refs.length ? await Publication.find(byRef).lean<Rec[]>() : [];
    const items = refs
      .map((i) => pubs.find((p) => p.type === i.type && p.slug === i.slug))
      .filter(Boolean)
      .map((p) => {
        const shown = p!.live?.data ?? p!;
        return { type: p!.type, slug: p!.slug, title: shown.title, summary: shown.summary };
      });
    const { config, mail } = this.deps;
    try {
      const { id } = await mail.createCampaignDraft({
        name: `${live.title} (${live.issueDate ?? today()})`,
        subject: live.title,
        html: newsletterCampaignHtml({ siteUrl: config.publicSiteUrl, siteName: "RNK Legalheads", issue: live as never, items }),
        listIds: [...new Set(Object.values(config.newsletter.listIds))],
      });
      record.campaignId = id;
      await record.save();
      await this.record(type, record, req, "email_draft", `Brevo campaign ${id}`);
      res.json({ campaignId: id });
    } catch (error) {
      logger.error("newsletter.campaign_failed", { error: (error as Error).message });
      res.status(502).json({ error: "provider_failed", message: "Brevo didn't accept the email draft. Please try again in a few minutes." });
    }
  };
}
