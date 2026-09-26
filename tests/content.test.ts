import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Publication } from "../src/models/content/Publication.js";
import { Service } from "../src/models/content/Service.js";
import { seedContent } from "../src/scripts/seed-content.js";
import { clearDb, makeApp, startDb, stopDb } from "./helpers.js";

const SEED = JSON.parse(readFileSync(new URL("../seed/content.json", import.meta.url), "utf8"));
const SECRET = "preview-secret-for-tests-0123456789";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedContent(SEED);
});

const app = () => makeApp({ CONTENT_PREVIEW_SECRET: SECRET });
const preview = (req: request.Test) => req.set("x-content-preview", SECRET);

describe("seed", () => {
  it("imports everything as drafts, and a second run changes nothing", async () => {
    expect(await Service.countDocuments()).toBe(40);
    expect(await Service.countDocuments({ status: "published" })).toBe(0);
    const again = await seedContent(SEED);
    expect(again.services).toEqual({ inserted: 0, updated: 0, unchanged: 40 });
  });

  it("keeps CMS edits unless --force is used", async () => {
    await Service.updateOne({ slug: "arbitration" }, { title: "Arbitration (edited)" });
    await seedContent(SEED);
    expect((await Service.findOne({ slug: "arbitration" }))?.title).toBe("Arbitration (edited)");
    await seedContent(SEED, true);
    expect((await Service.findOne({ slug: "arbitration" }))?.title).toBe("Arbitration");
  });
});

describe("GET /api/content/bundle", () => {
  it("round trip: with the preview secret, the API returns exactly the exported website content", async () => {
    const { app: a } = await app();
    const res = await preview(request(a).get("/api/content/bundle"));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toEqual(SEED);
  });

  it("public: drafts, previews and held services are never returned", async () => {
    const { app: a } = await app();
    const res = await request(a).get("/api/content/bundle");
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    for (const key of ["services", "industries", "people", "jobs", "publications", "newsletters"]) expect(res.body[key]).toEqual([]);
    expect(res.body.site.contactDetails.email).toBe("contact@rnklegalheads.com");
  });

  it("a wrong or missing secret gets the public view", async () => {
    const { app: a } = await app();
    const wrong = await request(a).get("/api/content/bundle").set("x-content-preview", "wrong");
    expect(wrong.body.services).toEqual([]);
    const { app: noSecret } = await makeApp();
    const none = await preview(request(noSecret).get("/api/content/bundle"));
    expect(none.body.services).toEqual([]);
  });

  it("publishing a record makes it public; a held service stays hidden even if published", async () => {
    await Service.updateMany({ slug: { $in: ["arbitration", "litigation-funding-advisory"] } }, { status: "published" });
    const { app: a } = await app();
    const res = await request(a).get("/api/content/bundle");
    expect(res.body.services.map((s: { slug: string }) => s.slug)).toEqual(["arbitration"]);
    expect(res.body.services[0].approved).toBe(true);
    expect(res.body.serviceDetails.S10.scope).toHaveLength(6);
  });
});

describe("per-type endpoints", () => {
  it("service detail includes overview, scope and related; drafts 404 publicly", async () => {
    const { app: a } = await app();
    expect((await request(a).get("/api/content/services/arbitration")).status).toBe(404);
    const res = await preview(request(a).get("/api/content/services/arbitration"));
    expect(res.body).toMatchObject({ id: "S10", title: "Arbitration", group: "disputes" });
    expect(res.body.scope).toHaveLength(6);
    expect(res.body.related).toHaveLength(3);
  });

  it("industries, people, jobs and newsletters list and detail", async () => {
    const { app: a } = await app();
    expect((await preview(request(a).get("/api/content/industries"))).body).toHaveLength(12);
    expect((await preview(request(a).get("/api/content/people/lawyer-profile-1"))).body.name).toBe("Lawyer profile 1");
    expect((await preview(request(a).get("/api/content/jobs"))).body[0].status).toBe("open");
    expect((await preview(request(a).get("/api/content/newsletters/rnk-legal-update"))).body.items).toHaveLength(3);
    expect((await preview(request(a).get("/api/content/people/nobody"))).status).toBe(404);
  });

  it("publications filter by type, service, year, court and text, with paging", async () => {
    await Publication.updateOne({ type: "article" }, { status: "published", preview: false, datePublished: "2026-09-01" });
    const { app: a } = await app();
    const all = await preview(request(a).get("/api/content/publications"));
    expect(all.body.total).toBe(3);
    expect((await preview(request(a).get("/api/content/publications?type=judgment"))).body.items[0].court).toBe("Court or tribunal");
    expect((await preview(request(a).get("/api/content/publications?service=arbitration"))).body.total).toBe(3);
    expect((await preview(request(a).get("/api/content/publications?service=civil-commercial-litigation"))).body.total).toBe(2);
    expect((await preview(request(a).get("/api/content/publications?year=2026"))).body.total).toBe(1);
    expect((await preview(request(a).get("/api/content/publications?q=regulatory"))).body.total).toBe(1);
    expect((await preview(request(a).get("/api/content/publications?court=Court%20or%20tribunal"))).body.total).toBe(1);
    const pub = await request(a).get("/api/content/publications");
    expect(pub.body).toMatchObject({ total: 1, page: 1, pageCount: 1 });
    expect(pub.body.items[0].publishedAt).toBe("2026-09-01");
    expect((await request(a).get("/api/content/publications/article/preparing-for-a-commercial-transaction")).status).toBe(200);
    expect((await request(a).get("/api/content/publications/podcast/x")).status).toBe(404);
  });

  it("search groups matches and returns nothing for an empty query", async () => {
    const { app: a } = await app();
    const res = await preview(request(a).get("/api/search?q=arbitration"));
    expect(res.body.services.map((s: { slug: string }) => s.slug)).toContain("arbitration");
    expect((await request(a).get("/api/search?q=")).body).toEqual({ services: [], people: [], publications: [], newsletters: [] });
    expect((await request(a).get("/api/search?q=arbitration")).body.services).toEqual([]);
  });
});
