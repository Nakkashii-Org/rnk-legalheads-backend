import { Industry } from "../models/content/Industry.js";
import { Job } from "../models/content/Job.js";
import { Newsletter } from "../models/content/Newsletter.js";
import { Person } from "../models/content/Person.js";
import { Publication } from "../models/content/Publication.js";
import { Service } from "../models/content/Service.js";
import { SiteSettings } from "../models/content/SiteSettings.js";

/**
 * Converts database records into the exact shape the website uses (its lib/content types), so
 * the frontend pages did not have to change. `approved` on the website means "published" here.
 */

type Doc = Record<string, unknown> & { status?: string; preview?: boolean; live?: { data?: Record<string, unknown> } };

export type Bundle = {
  site: Record<string, unknown>;
  services: Record<string, unknown>[];
  serviceDetails: Record<string, { overview: string; scope: { title: string; text: string }[]; related: string[] }>;
  industries: Record<string, unknown>[];
  people: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  publications: Record<string, unknown>[];
  newsletters: Record<string, unknown>[];
};

/** Drops empty values so the output matches the website's optional fields. */
function clean<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;
}

/** Live on the website: it has a published copy (or was marked published before phase D kept copies). */
const approved = (d: Doc) => d.status === "published" || Boolean(d.live?.data);

/**
 * Public: published records only (never previews; never held services).
 * Draft review and staff preview: every record except archived ones, with their latest saved text.
 */
function filterFor(includeDrafts: boolean): Record<string, unknown> {
  return includeDrafts
    ? { status: { $ne: "archived" } }
    : { $or: [{ "live.data": { $exists: true } }, { status: "published" }], preview: { $ne: true } };
}

/** The public website shows the published copy; edits saved since then stay in the CMS until published. */
function view(d: Doc, includeDrafts: boolean): Doc {
  return !includeDrafts && d.live?.data ? { ...d.live.data, status: "published" } : d;
}

export function serviceOut(d: Doc) {
  return clean({ id: d.serviceId, slug: d.slug, title: d.title, group: d.group, summary: d.summary, approved: approved(d), hold: d.hold || undefined });
}

export function publicationOut(d: Doc) {
  const base = {
    type: d.type,
    slug: d.slug,
    title: d.title,
    summary: d.summary,
    author: clean({ ...(d.author as Record<string, unknown>) }),
    publishedAt: d.datePublished,
    updatedAt: d.dateUpdated,
    serviceIds: d.serviceIds ?? [],
    body: d.body ?? [],
    image: (d.image as { src?: string })?.src ? { src: (d.image as { src: string }).src, alt: (d.image as { alt?: string }).alt ?? "" } : undefined,
    sources: ((d.sources as Record<string, unknown>[]) ?? []).map((s) => clean({ ...s })),
    approved: approved(d),
    preview: d.preview || undefined,
  };
  if (d.type === "judgment")
    return clean({
      ...base,
      caseName: d.caseName,
      court: d.court,
      caseNumber: d.caseNumber,
      neutralCitation: d.neutralCitation,
      decisionDate: d.decisionDate,
      officialSourceUrl: d.officialSourceUrl,
      proceduralStatus: d.proceduralStatus,
      sourceCheckedAt: d.sourceCheckedAt,
    });
  if (d.type === "update")
    return clean({
      ...base,
      issuer: d.issuer,
      instrument: d.instrument,
      status: d.instrumentStatus,
      instrumentPublishedOn: d.instrumentPublishedOn,
      effectiveDate: d.effectiveDate,
      officialSourceUrl: d.officialSourceUrl,
      sourceCheckedAt: d.sourceCheckedAt,
      updateNotes: d.updateNotes,
    });
  return clean(base);
}

/** Everything the website shows, in one response (GET /api/content/bundle). */
export async function loadBundle(includeDrafts: boolean): Promise<Bundle> {
  const filter = filterFor(includeDrafts);
  const [site, allServices, ...rest] = await Promise.all([
    SiteSettings.findOne({ key: "site" }).lean<Doc>(),
    Service.find(filter).sort({ serviceId: 1 }).lean<Doc[]>(),
    Industry.find(filter).sort({ _id: 1 }).lean<Doc[]>(),
    Person.find(filter).sort({ _id: 1 }).lean<Doc[]>(),
    Job.find(filter).sort({ _id: 1 }).lean<Doc[]>(),
    Publication.find(filter).sort({ datePublished: -1, _id: 1 }).lean<Doc[]>(),
    Newsletter.find(filter).sort({ issueDate: -1, _id: 1 }).lean<Doc[]>(),
  ]);
  const [industries, people, jobs, publications, newsletters] = rest.map((list) => list.map((d) => view(d, includeDrafts))) as Doc[][] as [Doc[], Doc[], Doc[], Doc[], Doc[]];
  // A held service is never public, whatever its published copy says.
  const services = allServices.map((d) => view(d, includeDrafts)).filter((d) => includeDrafts || !d.hold);

  const contact = (site?.contact as Record<string, unknown>) ?? {};
  return {
    site: site
      ? clean({
          name: site.name,
          legalEntity: site.legalEntity,
          established: site.established,
          statement: site.statement,
          disclaimer: site.disclaimer,
          contactDetails: clean({ address: contact.address, phone: contact.phone, email: contact.email, mapQuery: contact.mapQuery }),
        })
      : { name: "RNK Legalheads", established: 2024, statement: "", disclaimer: "", contactDetails: {} },
    services: services.map(serviceOut),
    serviceDetails: Object.fromEntries(
      services.map((d) => [d.serviceId as string, { overview: (d.overview as string) ?? "", scope: (d.scope as { title: string; text: string }[]) ?? [], related: (d.related as string[]) ?? [] }]),
    ),
    industries: industries.map((d) =>
      clean({
        slug: d.slug,
        name: d.name,
        summary: d.summary,
        serviceIds: d.serviceIds ?? [],
        approved: approved(d),
        intro: d.intro,
        overview: d.overview,
        workAreas: d.workAreas,
        homeOrder: d.homeOrder,
      }),
    ),
    people: people.map((d) =>
      clean({
        slug: d.slug,
        name: d.name,
        role: d.role,
        practiceSummary: d.practiceSummary,
        biography: d.biography ?? [],
        priorExperience: d.priorExperience,
        qualifications: d.qualifications,
        enrolment: d.enrolment,
        languages: d.languages,
        office: d.office,
        serviceIds: d.serviceIds ?? [],
        portrait: (d.portrait as { src?: string })?.src ? { src: (d.portrait as { src: string }).src, alt: (d.portrait as { alt?: string }).alt ?? "" } : undefined,
        approved: approved(d),
        preview: d.preview || undefined,
      }),
    ),
    jobs: jobs.map((d) =>
      clean({
        jobId: d.jobId,
        slug: d.slug,
        title: d.title,
        practice: d.practice,
        location: d.location,
        workArrangement: d.workArrangement,
        experience: d.experience,
        summary: d.summary,
        responsibilities: d.responsibilities ?? [],
        qualifications: d.qualifications ?? [],
        applicationInstructions: d.applicationInstructions,
        applicationEmail: d.applicationEmail,
        openedOn: d.openedOn,
        closesOn: d.closesOn,
        status: d.vacancyStatus,
        approved: approved(d),
        preview: d.preview || undefined,
      }),
    ),
    publications: publications.map(publicationOut),
    newsletters: newsletters.map((d) =>
      clean({
        slug: d.slug,
        title: d.title,
        focus: d.focus,
        issueDate: d.issueDate,
        introduction: d.introduction,
        contents: d.contents ?? [],
        items: d.items ?? [],
        approved: approved(d),
        preview: d.preview || undefined,
      }),
    ),
  };
}
