/**
 * Imports the website content snapshot (seed/content.json, exported from the frontend with
 * scripts/export-content.ts) into MongoDB.
 *
 *   npm run seed            add records that are missing; never overwrite existing ones
 *   npm run seed -- --force also overwrite existing records with the file's version
 *
 * Records keep their approval state: everything in the snapshot is a draft (guide p.150: import
 * as drafts, then approve each record; never switch everything on at once).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import mongoose, { type Model } from "mongoose";
import { loadConfig } from "../config.js";
import { Industry } from "../models/content/Industry.js";
import { Job } from "../models/content/Job.js";
import { Newsletter } from "../models/content/Newsletter.js";
import { Person } from "../models/content/Person.js";
import { Publication } from "../models/content/Publication.js";
import { Service } from "../models/content/Service.js";
import { SiteSettings } from "../models/content/SiteSettings.js";

type Rec = Record<string, any>;
export type SeedResult = Record<string, { inserted: number; updated: number; unchanged: number }>;

const statusOf = (r: Rec) => (r.approved ? "published" : "draft");

async function upsert(model: Model<any>, filter: Rec, doc: Rec, force: boolean, tally: SeedResult[string]) {
  if (force) {
    const res = await model.updateOne(filter, { $set: doc }, { upsert: true, runValidators: true });
    if (res.upsertedCount) tally.inserted++;
    else if (res.modifiedCount) tally.updated++;
    else tally.unchanged++;
  } else {
    const res = await model.updateOne(filter, { $setOnInsert: doc }, { upsert: true, runValidators: true });
    if (res.upsertedCount) tally.inserted++;
    else tally.unchanged++;
  }
}

/** Seeds from an already-parsed snapshot. Exported for tests. */
export async function seedContent(data: Rec, force = false): Promise<SeedResult> {
  const result: SeedResult = {};
  const tally = (name: string) => (result[name] ??= { inserted: 0, updated: 0, unchanged: 0 });

  const s = data.site;
  await upsert(
    SiteSettings,
    { key: "site" },
    {
      key: "site",
      name: s.name,
      legalEntity: s.legalEntity,
      established: s.established,
      statement: s.statement,
      disclaimer: s.disclaimer,
      contact: s.contactDetails ?? {},
    },
    force,
    tally("siteSettings"),
  );

  for (const r of data.services as Rec[]) {
    const d = data.serviceDetails?.[r.id] ?? {};
    await upsert(
      Service,
      { serviceId: r.id },
      {
        serviceId: r.id,
        slug: r.slug,
        title: r.title,
        group: r.group,
        summary: r.summary,
        overview: d.overview ?? "",
        scope: d.scope ?? [],
        related: d.related ?? [],
        hold: Boolean(r.hold),
        status: statusOf(r),
      },
      force,
      tally("services"),
    );
  }

  for (const r of data.industries as Rec[])
    await upsert(
      Industry,
      { slug: r.slug },
      {
        slug: r.slug,
        name: r.name,
        summary: r.summary,
        serviceIds: r.serviceIds ?? [],
        intro: r.intro,
        overview: r.overview,
        workAreas: r.workAreas,
        homeOrder: r.homeOrder,
        status: statusOf(r),
      },
      force,
      tally("industries"),
    );

  for (const r of data.people as Rec[]) {
    const { approved: _a, preview, ...fields } = r;
    await upsert(Person, { slug: r.slug }, { ...fields, preview: Boolean(preview), status: statusOf(r) }, force, tally("people"));
  }

  for (const r of data.jobs as Rec[]) {
    const { approved: _a, preview, status: vacancyStatus, ...fields } = r;
    await upsert(Job, { slug: r.slug }, { ...fields, vacancyStatus, preview: Boolean(preview), status: statusOf(r) }, force, tally("jobs"));
  }

  for (const r of data.publications as Rec[]) {
    const { approved: _a, preview, publishedAt, updatedAt, status: instrumentStatus, ...fields } = r;
    await upsert(
      Publication,
      { type: r.type, slug: r.slug },
      { ...fields, datePublished: publishedAt, dateUpdated: updatedAt, instrumentStatus, preview: Boolean(preview), status: statusOf(r) },
      force,
      tally("publications"),
    );
  }

  for (const r of data.newsletters as Rec[]) {
    const { approved: _a, preview, ...fields } = r;
    await upsert(Newsletter, { slug: r.slug }, { ...fields, preview: Boolean(preview), status: statusOf(r) }, force, tally("newsletters"));
  }

  return result;
}

async function main() {
  const force = process.argv.includes("--force");
  const file = path.resolve(process.argv.find((a) => a.endsWith(".json")) ?? "seed/content.json");
  const config = loadConfig();
  const data = JSON.parse(await readFile(file, "utf8"));
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  // Build the unique indexes first so duplicates are refused rather than silently created.
  await Promise.all([Service, Industry, Person, Job, Publication, Newsletter, SiteSettings].map((m) => m.init()));
  const result = await seedContent(data, force);
  await mongoose.disconnect();
  console.log(`Seeded from ${file}${force ? " (--force: existing records overwritten)" : " (existing records kept)"}`);
  console.table(result);
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && /seed-content\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
