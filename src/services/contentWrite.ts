import { Person } from "../models/content/Person.js";
import { Publication } from "../models/content/Publication.js";
import { Service } from "../models/content/Service.js";

/**
 * Turns the CMS editor's field values into database records (C2), with the same rules as the
 * editor (frontend lib/admin/config.ts). The server never trusts the browser's checks.
 *
 * - Saving a draft needs only a title and a valid, unique URL slug.
 * - Sending for review needs every required field (reviewProblems).
 */

type Values = Record<string, unknown>;
type Doc = Record<string, unknown>;
export type FieldErrors = Record<string, string>;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/\S+\.\S+$/;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown) => v === true;
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : []);
const opt = (v: string) => v || undefined;

// ---- Rich text → plain-text blocks (safe by construction: no HTML is ever stored) ----

export type Block = { kind: "h2" | "h3" | "p" | "ul"; text?: string; items?: string[] };

function decode(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Headings, paragraphs and lists from the editor's HTML. Scripts, styles and attributes are dropped.
 * Read tag by tag, because browsers nest blocks freely (a list inside a paragraph, a heading
 * inside a div); nested lists are flattened into their outer list.
 */
export function htmlToBlocks(html: string): Block[] {
  const clean = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  const blocks: Block[] = [];
  let text = "";
  let heading: "h2" | "h3" | null = null;
  let listDepth = 0;
  let items: string[] = [];

  const flushText = () => {
    const t = decode(text);
    text = "";
    if (!t) return;
    if (heading) blocks.push({ kind: heading, text: t });
    else if (listDepth > 0) items.push(t);
    else blocks.push({ kind: "p", text: t });
  };

  for (const m of clean.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>|[^<]+|</gi)) {
    const tag = m[2]?.toLowerCase();
    if (!tag) {
      text += m[0];
      continue;
    }
    const closing = m[1] === "/";
    if (/^h[1-6]$/.test(tag)) {
      flushText();
      heading = closing ? null : tag === "h1" || tag === "h2" ? "h2" : "h3";
    } else if (tag === "ul" || tag === "ol") {
      flushText();
      if (!closing) listDepth++;
      else if (listDepth > 0 && --listDepth === 0) {
        if (items.length) blocks.push({ kind: "ul", items });
        items = [];
      }
    } else if (["li", "p", "div", "blockquote", "br", "section", "article"].includes(tag)) {
      flushText();
    }
    // Inline tags (b, i, a, span…) are dropped; their text is kept.
  }
  flushText();
  if (items.length) blocks.push({ kind: "ul", items });
  return blocks;
}

const blocksText = (blocks: Block[]) => blocks.map((b) => (b.kind === "ul" ? (b.items ?? []).join(" ") : b.text)).join(" ");

// ---- Per-type mapping ----

type TypeRules = {
  /** Editor field that holds the title (used in messages and the draft rule). */
  titleField: string;
  titleLabel: string;
  /** Required before "Send for review": editor field → label. */
  required: Record<string, string>;
  sourceCheck?: boolean;
  toDoc: (v: Values) => Promise<{ doc: Doc; errors: FieldErrors }>;
};

async function checkServices(ids: string[], field: string, errors: FieldErrors) {
  if (!ids.length) return;
  const found = await Service.countDocuments({ serviceId: { $in: ids } });
  if (found !== new Set(ids).size) errors[field] = "One of the chosen services no longer exists. Remove it and choose again.";
}
async function checkPeople(slugs: string[], field: string, errors: FieldErrors) {
  if (!slugs.length) return;
  const found = await Person.countDocuments({ slug: { $in: slugs } });
  if (found !== new Set(slugs).size) errors[field] = "One of the chosen people no longer exists. Remove them and choose again.";
}
function checkLength(v: string, max: number, field: string, label: string, errors: FieldErrors) {
  if (v.length > max) errors[field] = `${label} must be ${max} characters or fewer.`;
}
function checkDate(v: string, field: string, label: string, errors: FieldErrors) {
  if (v && (!DATE.test(v) || Number.isNaN(Date.parse(v)))) errors[field] = `${label} must be a real date.`;
}
function checkUrl(v: string, field: string, errors: FieldErrors) {
  if (v && !URL_RE.test(v)) errors[field] = "Enter a full link starting with https://";
}

const workAreas = (v: unknown) =>
  (Array.isArray(v) ? v : []).map((w) => ({ title: str((w as Values)?.title), text: str((w as Values)?.text) })).filter((w) => w.title || w.text);

async function publicationDoc(type: "article" | "judgment" | "update", v: Values) {
  const errors: FieldErrors = {};
  const summary = str(v.summary);
  checkLength(summary, 240, "summary", "Summary", errors);
  const html = typeof v.body === "string" ? v.body : "";
  if (html.length > 100_000) errors.body = "The article is too long to save.";
  const body = htmlToBlocks(html);

  const authorSlug = strList(v.author)[0];
  let authorName = "";
  if (authorSlug) {
    const person = await Person.findOne({ slug: authorSlug }, { name: 1 }).lean<{ name: string }>();
    if (!person) errors.author = "The chosen author no longer exists. Choose again.";
    else authorName = person.name;
  }
  const serviceIds = strList(v.services);
  await checkServices(serviceIds, "services", errors);

  const sources = (Array.isArray(v.sources) ? v.sources : [])
    .map((s) => ({ label: str((s as Values)?.label), url: str((s as Values)?.url) }))
    .filter((s) => s.label || s.url);
  if (sources.some((s) => s.url && !URL_RE.test(s.url))) errors.sources = "Each source link must start with https://";

  const seoTitle = str(v.seoTitle);
  const seoDescription = str(v.seoDescription);
  checkLength(seoTitle, 60, "seoTitle", "Search title", errors);
  checkLength(seoDescription, 160, "seoDescription", "Search description", errors);

  const doc: Doc = {
    type,
    title: str(v.title),
    summary,
    body,
    author: { name: authorName, personSlug: authorSlug || undefined },
    serviceIds,
    sources: sources.map((s) => ({ label: s.label || s.url, url: opt(s.url) })),
    seoTitle: opt(seoTitle),
    seoDescription: opt(seoDescription),
  };
  if (type === "judgment") {
    const decisionDate = str(v.decisionDate);
    checkDate(decisionDate, "decisionDate", "Decision date", errors);
    checkUrl(str(v.officialSourceUrl), "officialSourceUrl", errors);
    Object.assign(doc, {
      caseName: opt(str(v.caseName)),
      court: opt(str(v.court)),
      caseNumber: opt(str(v.caseNumber)),
      neutralCitation: opt(str(v.neutralCitation)),
      decisionDate: opt(decisionDate),
      officialSourceUrl: opt(str(v.officialSourceUrl)),
      proceduralStatus: opt(str(v.proceduralStatus)),
    });
  }
  if (type === "update") {
    const status = str(v.status);
    if (status && !["proposed", "notified", "in-force"].includes(status)) errors.status = "Choose Proposed, Notified or In force.";
    checkDate(str(v.instrumentPublishedOn), "instrumentPublishedOn", "Publication date", errors);
    checkDate(str(v.effectiveDate), "effectiveDate", "Commencement date", errors);
    checkUrl(str(v.officialSourceUrl), "officialSourceUrl", errors);
    Object.assign(doc, {
      issuer: opt(str(v.issuer)),
      instrument: opt(str(v.instrument)),
      instrumentStatus: opt(status),
      instrumentPublishedOn: opt(str(v.instrumentPublishedOn)),
      effectiveDate: opt(str(v.effectiveDate)),
      officialSourceUrl: opt(str(v.officialSourceUrl)),
    });
  }
  return { doc, errors };
}

const publicationRequired: Record<string, string> = { title: "Title", slug: "URL slug", summary: "Summary", body: "Article body", author: "Author" };

export const RULES: Record<string, TypeRules> = {
  articles: { titleField: "title", titleLabel: "Title", required: publicationRequired, toDoc: (v) => publicationDoc("article", v) },
  judgments: {
    titleField: "title",
    titleLabel: "Title",
    sourceCheck: true,
    required: {
      ...publicationRequired,
      body: "Note body",
      caseName: "Official case name",
      court: "Court or tribunal",
      caseNumber: "Case number",
      decisionDate: "Decision date",
      officialSourceUrl: "Official judgment URL",
      proceduralStatus: "Procedural status",
    },
    toDoc: (v) => publicationDoc("judgment", v),
  },
  "legal-updates": {
    titleField: "title",
    titleLabel: "Title",
    sourceCheck: true,
    required: { ...publicationRequired, body: "Update body", issuer: "Issuing authority", instrument: "Instrument title and number", status: "Status", officialSourceUrl: "Official source URL" },
    toDoc: (v) => publicationDoc("update", v),
  },
  newsletters: {
    titleField: "title",
    titleLabel: "Title",
    required: { title: "Title", slug: "URL slug", issueDate: "Issue date", introduction: "Introduction", items: "Publications" },
    toDoc: async (v) => {
      const errors: FieldErrors = {};
      const introduction = str(v.introduction);
      checkLength(introduction, 600, "introduction", "Introduction", errors);
      checkDate(str(v.issueDate), "issueDate", "Issue date", errors);
      const items = strList(v.items).map((ref) => {
        const [type, ...rest] = ref.split(":");
        return { type: type!, slug: rest.join(":") };
      });
      if (items.some((i) => !["article", "judgment", "update"].includes(i.type) || !SLUG.test(i.slug))) errors.items = "Choose publications from the list.";
      else if (items.length) {
        const filter: Record<string, unknown> = { $or: items.map((i) => ({ type: i.type, slug: i.slug })) };
        const found = await Publication.countDocuments(filter);
        if (found !== items.length) errors.items = "One of the chosen publications no longer exists. Remove it and choose again.";
      }
      return { doc: { title: str(v.title), focus: str(v.focus), issueDate: opt(str(v.issueDate)), introduction, items }, errors };
    },
  },
  services: {
    titleField: "title",
    titleLabel: "Service name",
    required: { title: "Service name", slug: "URL slug", group: "Service group", summary: "Summary", overview: "Overview", scope: "Scope of work" },
    toDoc: async (v) => {
      const errors: FieldErrors = {};
      const summary = str(v.summary);
      checkLength(summary, 200, "summary", "Summary", errors);
      const group = str(v.group);
      if (group && !["business", "disputes", "tax", "property", "ip", "people", "regulated"].includes(group)) errors.group = "Choose a service group.";
      const related = strList(v.related);
      if (related.length > 3) errors.related = "Choose up to 3 related services.";
      await checkServices(related, "related", errors);
      const people = strList(v.people);
      await checkPeople(people, "people", errors);
      return {
        doc: {
          title: str(v.title),
          group: group || undefined,
          summary,
          overview: str(v.overview),
          scope: workAreas(v.scope),
          related,
          people,
          owner: opt(str(v.owner)),
          jurisdiction: opt(str(v.jurisdiction)),
          hold: bool(v.hold),
          seoTitle: opt(str(v.seoTitle)),
          seoDescription: opt(str(v.seoDescription)),
        },
        errors,
      };
    },
  },
  people: {
    titleField: "name",
    titleLabel: "Full name",
    required: { name: "Full name", slug: "URL slug", role: "Role", practiceSummary: "Practice summary", biography: "Approved biography" },
    toDoc: async (v) => {
      const errors: FieldErrors = {};
      const practiceSummary = str(v.practiceSummary);
      checkLength(practiceSummary, 200, "practiceSummary", "Practice summary", errors);
      const biography = htmlToBlocks(typeof v.biography === "string" ? v.biography : "")
        .map((b) => (b.kind === "ul" ? (b.items ?? []).join("; ") : b.text!))
        .filter(Boolean);
      const serviceIds = strList(v.services);
      await checkServices(serviceIds, "services", errors);
      return {
        doc: {
          name: str(v.name),
          role: str(v.role),
          practiceSummary,
          biography,
          priorExperience: opt(str(v.priorExperience)),
          qualifications: opt(str(v.qualifications)),
          enrolment: opt(str(v.enrolment)),
          languages: opt(str(v.languages)),
          office: opt(str(v.office)),
          portraitConsent: bool(v.portraitConsent),
          serviceIds,
        },
        errors,
      };
    },
  },
  industries: {
    titleField: "name",
    titleLabel: "Sector name",
    required: { name: "Sector name", slug: "URL slug", summary: "Summary", services: "Related services" },
    toDoc: async (v) => {
      const errors: FieldErrors = {};
      const summary = str(v.summary);
      checkLength(summary, 200, "summary", "Summary", errors);
      const serviceIds = strList(v.services);
      await checkServices(serviceIds, "services", errors);
      const people = strList(v.people);
      await checkPeople(people, "people", errors);
      const areas = workAreas(v.workAreas);
      return {
        doc: { name: str(v.name), summary, intro: opt(str(v.intro)), overview: opt(str(v.overview)), workAreas: areas.length ? areas : undefined, serviceIds, people },
        errors,
      };
    },
  },
  jobs: {
    titleField: "title",
    titleLabel: "Role title",
    required: {
      jobId: "Job ID",
      title: "Role title",
      slug: "URL slug",
      practice: "Practice",
      location: "Location",
      workArrangement: "Work arrangement",
      experience: "Experience",
      summary: "Summary",
      responsibilities: "Responsibilities",
      qualifications: "Qualifications",
      applicationInstructions: "Application instructions",
      jobStatus: "Vacancy status",
    },
    toDoc: async (v) => {
      const errors: FieldErrors = {};
      checkDate(str(v.openedOn), "openedOn", "Opening date", errors);
      checkDate(str(v.closesOn), "closesOn", "Closing date", errors);
      const jobStatus = str(v.jobStatus);
      if (jobStatus && !["open", "closed"].includes(jobStatus)) errors.jobStatus = "Choose Open or Closed.";
      return {
        doc: {
          jobId: str(v.jobId) || undefined,
          title: str(v.title),
          practice: str(v.practice),
          location: str(v.location),
          workArrangement: str(v.workArrangement),
          experience: str(v.experience),
          summary: str(v.summary),
          responsibilities: strList(v.responsibilities),
          qualifications: strList(v.qualifications),
          applicationInstructions: str(v.applicationInstructions),
          openedOn: opt(str(v.openedOn)),
          closesOn: opt(str(v.closesOn)),
          vacancyStatus: jobStatus || "open",
        },
        errors,
      };
    },
  },
};

/** Rules for saving a draft: a title, a valid slug, and whatever the type's mapping checks. */
export async function draftProblems(type: string, v: Values): Promise<{ doc: Doc; errors: FieldErrors }> {
  const rules = RULES[type]!;
  const { doc, errors } = await rules.toDoc(v);
  const title = str(v[rules.titleField]);
  if (!title) errors[rules.titleField] = `${rules.titleLabel} is required to save a draft.`;
  else if (title.length > 200) errors[rules.titleField] = `${rules.titleLabel} must be 200 characters or fewer.`;
  const slug = str(v.slug);
  if (!SLUG.test(slug) || slug.length > 100) errors.slug = "Use lowercase letters, numbers and single hyphens only.";
  return { doc: { ...doc, slug }, errors };
}

/** Everything "Send for review" requires, checked on the saved record's editor values. */
export function reviewProblems(type: string, v: Values): FieldErrors {
  const rules = RULES[type]!;
  const errors: FieldErrors = {};
  for (const [field, label] of Object.entries(rules.required)) {
    const value = v[field];
    const empty =
      value === undefined ||
      value === null ||
      value === false ||
      (typeof value === "string" && !(field === "body" || field === "biography" ? htmlToBlocks(value).length : value.trim())) ||
      (Array.isArray(value) && (value.length === 0 || (field === "scope" && (value as { title?: string; text?: string }[]).some((w) => !str(w?.title) || !str(w?.text)))));
    if (empty) errors[field] = field === "scope" ? "Complete every scope of work entry." : `${label} is required.`;
  }
  if (type === "services" && Array.isArray(v.scope) && v.scope.length !== 6 && !errors.scope) errors.scope = "A service needs exactly 6 work areas.";
  if (rules.sourceCheck && v.sourceChecked !== true) errors.sourceChecked = "Confirm that the primary source has been checked.";
  return errors;
}

export { blocksText };
