import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { PUBLICATION_TYPES } from "../models/content/Publication.js";
import { loadBundle, type Bundle } from "../services/content.js";
import type { Deps } from "../types.js";

const PAGE_SIZE = 12;
const MAX_QUERY = 100;

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown) => (typeof first(v) === "string" ? (first(v) as string) : "");
const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text: string, ws: string[]) => ws.every((w) => text.toLowerCase().includes(w));

type Rec = Record<string, any>;

/**
 * Public, read-only content APIs (plan section 3.2). Only published records are returned, unless
 * the request carries the website server's preview secret (draft review mode).
 */
export class ContentController {
  constructor(private readonly deps: Deps) {}

  private includeDrafts(req: Request): boolean {
    const secret = this.deps.config.contentPreviewSecret;
    const sent = req.get("x-content-preview");
    if (!secret || !sent) return false;
    const a = Buffer.from(sent);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Loads the content and sets caching: public answers may be cached briefly; draft answers never. */
  private async load(req: Request, res: Response): Promise<Bundle> {
    const drafts = this.includeDrafts(req);
    res.set("Cache-Control", drafts ? "private, no-store" : "public, max-age=60");
    return loadBundle(drafts);
  }

  private notFound = (res: Response) => void res.status(404).json({ error: "not_found" });

  /** GET /api/content/bundle: everything the website needs, in one response. */
  bundle = async (req: Request, res: Response) => {
    res.json(await this.load(req, res));
  };

  /** GET /api/content/site-settings */
  siteSettings = async (req: Request, res: Response) => {
    res.json((await this.load(req, res)).site);
  };

  /** GET /api/content/services */
  services = async (req: Request, res: Response) => {
    res.json((await this.load(req, res)).services);
  };

  /** GET /api/content/services/:slug → the service with its overview, scope and related services. */
  service = async (req: Request, res: Response) => {
    const b = await this.load(req, res);
    const s = b.services.find((x) => x.slug === req.params.slug);
    if (!s) return this.notFound(res);
    res.json({ ...s, ...b.serviceDetails[s.id as string] });
  };

  /** GET /api/content/:collection and /:collection/:slug for industries, people, jobs, newsletters. */
  list = (key: "industries" | "people" | "jobs" | "newsletters") => async (req: Request, res: Response) => {
    res.json((await this.load(req, res))[key]);
  };
  one = (key: "industries" | "people" | "jobs" | "newsletters") => async (req: Request, res: Response) => {
    const item = (await this.load(req, res))[key].find((x) => x.slug === req.params.slug);
    if (!item) return this.notFound(res);
    res.json(item);
  };

  /** GET /api/content/publications?type=&service=&year=&court=&q=&page= */
  publications = async (req: Request, res: Response) => {
    const b = await this.load(req, res);
    const type = str(req.query.type);
    const serviceSlug = str(req.query.service);
    const year = str(req.query.year);
    const court = str(req.query.court);
    const q = words(str(req.query.q).slice(0, MAX_QUERY));
    const serviceId = b.services.find((s) => s.slug === serviceSlug)?.id;

    const filtered = b.publications.filter(
      (p: Rec) =>
        (!type || p.type === type) &&
        (!serviceSlug || p.serviceIds.includes(serviceId)) &&
        (!year || String(p.publishedAt ?? "").startsWith(year)) &&
        (!court || p.court === court) &&
        (q.length === 0 || matches(publicationText(p), q)),
    );
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const page = Math.min(Math.max(1, Number.parseInt(str(req.query.page), 10) || 1), pageCount);
    res.json({ items: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: filtered.length, page, pageCount });
  };

  /** GET /api/content/publications/:type/:slug */
  publication = async (req: Request, res: Response) => {
    if (!(PUBLICATION_TYPES as readonly string[]).includes(req.params.type as string)) return this.notFound(res);
    const p = (await this.load(req, res)).publications.find((x) => x.type === req.params.type && x.slug === req.params.slug);
    if (!p) return this.notFound(res);
    res.json(p);
  };

  /** GET /api/search?q= → matching services, people, publications and newsletter issues. */
  search = async (req: Request, res: Response) => {
    const q = words(str(req.query.q).slice(0, MAX_QUERY));
    if (q.length === 0) return void res.json({ services: [], people: [], publications: [], newsletters: [] });
    const b = await this.load(req, res);
    const serviceText = (s: Rec) => {
      const d = b.serviceDetails[s.id];
      return `${s.title} ${s.summary} ${d?.scope.map((a) => `${a.title} ${a.text}`).join(" ") ?? ""}`;
    };
    res.json({
      services: b.services.filter((s) => matches(serviceText(s), q)).map((s) => ({ slug: s.slug, title: s.title, summary: s.summary })),
      people: b.people
        .filter((p: Rec) => matches(`${p.name} ${p.role} ${p.practiceSummary} ${p.biography.join(" ")}`, q))
        .map((p: Rec) => ({ slug: p.slug, name: p.name, role: p.role })),
      publications: b.publications
        .filter((p: Rec) => matches(publicationText(p), q))
        .map((p: Rec) => ({ type: p.type, slug: p.slug, title: p.title, summary: p.summary })),
      newsletters: b.newsletters
        .filter((n: Rec) => matches(`${n.title} ${n.focus ?? ""} ${n.introduction} ${n.contents.join(" ")}`, q))
        .map((n: Rec) => ({ slug: n.slug, title: n.title })),
    });
  };
}

function publicationText(p: Rec): string {
  const body = (p.body as Rec[]).map((b) => (b.kind === "ul" ? b.items.join(" ") : b.text)).join(" ");
  const extra = p.type === "judgment" ? `${p.caseName} ${p.court}` : p.type === "update" ? `${p.issuer} ${p.instrument}` : "";
  return `${p.title} ${p.summary} ${p.author?.name ?? ""} ${extra} ${body}`;
}
