import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditEvent } from "../src/models/AuditEvent.js";
import { Revision } from "../src/models/Revision.js";
import { Publication } from "../src/models/content/Publication.js";
import { Service } from "../src/models/content/Service.js";
import { seedContent } from "../src/scripts/seed-content.js";
import { htmlToBlocks } from "../src/services/contentWrite.js";
import { clearDb, makeApp, ORIGIN, signedInAgent as signIn, startDb, stopDb } from "./helpers.js";

// Writes need the site Origin header (requireOrigin), so every agent sends it.
const signedInAgent = async (...args: Parameters<typeof signIn>) => (await signIn(...args)).set("Origin", ORIGIN);

const SEED = JSON.parse(readFileSync(new URL("../seed/content.json", import.meta.url), "utf8"));

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedContent(SEED);
});

const article = {
  title: "Contracts after the new rules",
  slug: "contracts-after-the-new-rules",
  summary: "What changes for commercial contracts.",
  body: "<h2>Overview</h2><p>First &amp; <b>main</b> point.</p><script>alert(1)</script><ul><li>One</li><li>Two</li></ul>",
  author: ["lawyer-profile-1"],
  services: ["S10"],
};

describe("CMS writing (C2)", () => {
  it("needs a signed-in user", async () => {
    const app = await makeApp();
    expect((await request(app.app).post("/api/admin/content/articles").set("Origin", ORIGIN).send({ values: article })).status).toBe(401);
    expect((await request(app.app).patch("/api/admin/content/services/arbitration").set("Origin", ORIGIN).send({ values: {} })).status).toBe(401);
    expect((await request(app.app).get("/api/admin/preview-bundle")).status).toBe(401);
  });

  it("converts editor HTML to safe plain-text blocks", () => {
    expect(htmlToBlocks(article.body)).toEqual([
      { kind: "h2", text: "Overview" },
      { kind: "p", text: "First & main point." },
      { kind: "ul", items: ["One", "Two"] },
    ]);
  });

  it("keeps headings and lists apart when the browser nests them", () => {
    const html =
      "<h2>Heading 1</h2><p><ul><li>Point 1 in heading 1</li><li>Point 2 in heading 1</li></ul></p><div><h2>Heading 2</h2><ul><li>Point 1<br></li><li>Point 2 <ul><li>nested</li></ul></li></ul></div><p>Last line<br>second line</p>";
    expect(htmlToBlocks(html)).toEqual([
      { kind: "h2", text: "Heading 1" },
      { kind: "ul", items: ["Point 1 in heading 1", "Point 2 in heading 1"] },
      { kind: "h2", text: "Heading 2" },
      { kind: "ul", items: ["Point 1", "Point 2", "nested"] },
      { kind: "p", text: "Last line" },
      { kind: "p", text: "second line" },
    ]);
  });

  it("creates a draft with only a title and slug, keeping revision 1", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const res = await agent.post("/api/admin/content/articles").send({ values: { title: "Rough idea", slug: "rough-idea" } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "rough-idea", status: "draft", revision: 1 });
    const saved = await Publication.findOne({ slug: "rough-idea" }).lean();
    expect(saved).toMatchObject({ type: "article", status: "draft", createdBy: "writer@example.com", revision: 1 });
    expect(await Revision.countDocuments({ contentType: "articles" })).toBe(1);
    expect(await AuditEvent.countDocuments({ action: "content.created" })).toBe(1);
  });

  it("rejects a draft without title, with a bad or taken slug, or with unknown links", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const empty = await agent.post("/api/admin/content/articles").send({ values: { slug: "Bad Slug" } });
    expect(empty.status).toBe(422);
    expect(Object.keys(empty.body.errors).sort()).toEqual(["slug", "title"]);

    const taken = await agent.post("/api/admin/content/articles").send({ values: { title: "X", slug: "preparing-for-a-commercial-transaction" } });
    expect(taken.body.errors.slug).toContain("already used");

    const links = await agent.post("/api/admin/content/articles").send({ values: { ...article, services: ["S99"], author: ["nobody"], sources: [{ label: "x", url: "ftp://x" }] } });
    expect(Object.keys(links.body.errors).sort()).toEqual(["author", "services", "sources"]);
    expect((await agent.post("/api/admin/content/podcasts").send({ values: article })).status).toBe(404);
  });

  it("gives a new service the next service ID", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    await agent.post("/api/admin/content/services").send({ values: { title: "Space law", slug: "space-law" } }).expect(201);
    expect((await Service.findOne({ slug: "space-law" }).lean())?.serviceId).toBe("S41");
  });

  it("saves edits as new revisions and converts the body", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    await agent.post("/api/admin/content/articles").send({ values: { title: "Rough idea", slug: "rough-idea" } });
    const res = await agent.patch("/api/admin/content/articles/rough-idea").send({ values: article });
    expect(res.body).toEqual({ id: article.slug, status: "draft", revision: 2 });
    const saved = await Publication.findOne({ slug: article.slug }).lean();
    expect(saved?.author).toMatchObject({ personSlug: "lawyer-profile-1" });
    expect(saved?.author?.name).toBeTruthy();
    expect(saved?.body).toHaveLength(3);

    const list = await agent.get(`/api/admin/content/articles/${article.slug}/revisions`);
    expect(list.body.revisions.map((r: { number: number; action: string }) => `${r.number}:${r.action}`)).toEqual(["2:saved", "1:created"]);
  });

  it("send for review runs every check, then moves the record to In review", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    await agent.post("/api/admin/content/articles").send({ values: { title: "Rough idea", slug: "rough-idea" } });

    const missing = await agent.post("/api/admin/content/articles/rough-idea/submit").send({ values: { title: "Rough idea", slug: "rough-idea" } });
    expect(missing.status).toBe(422);
    expect(missing.body.errors).toMatchObject({ summary: "Summary is required.", body: "Article body is required.", author: "Author is required." });
    expect((await Publication.findOne({ slug: "rough-idea" }).lean())?.status).toBe("draft");

    const ok = await agent.post("/api/admin/content/articles/rough-idea/submit").send({ values: article });
    expect(ok.body).toMatchObject({ id: article.slug, status: "in_review" });
    expect((await agent.post(`/api/admin/content/articles/${article.slug}/submit`).send({ values: article })).status).toBe(409);

    // Editing a record in review takes it back to draft.
    expect((await agent.patch(`/api/admin/content/articles/${article.slug}`).send({ values: article })).body.status).toBe("draft");
  });

  it("judgments need the source check; services need 6 complete work areas", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const j = await agent.post("/api/admin/content/judgments/a-structured-note-on-a-recent-decision/submit").send({ values: { title: "Note", slug: "a-structured-note-on-a-recent-decision" } });
    expect(j.body.errors.sourceChecked).toBe("Confirm that the primary source has been checked.");

    const scope = Array.from({ length: 5 }, (_, i) => ({ title: `Area ${i}`, text: "Text" }));
    const s = await agent
      .post("/api/admin/content/services/arbitration/submit")
      .send({ values: { title: "Arbitration", slug: "arbitration", group: "disputes", summary: "S", overview: "O", scope } });
    expect(s.body.errors.scope).toBe("A service needs exactly 6 work areas.");
  });

  it("approved and published records can't be edited yet", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "admin@example.com", ["admin"]);
    await Service.updateOne({ slug: "arbitration" }, { status: "published" });
    const res = await agent.patch("/api/admin/content/services/arbitration").send({ values: { title: "Arbitration", slug: "arbitration" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("locked");
  });

  it("delete: only the creator or an Administrator, only unlinked never-published drafts", async () => {
    const app = await makeApp();
    const writer = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const other = await signedInAgent(app, "other@example.com", ["publisher"]);
    const admin = await signedInAgent(app, "admin@example.com", ["admin"]);
    await writer.post("/api/admin/content/articles").send({ values: { title: "Rough idea", slug: "rough-idea" } });

    expect((await other.delete("/api/admin/content/articles/rough-idea")).status).toBe(403);
    expect((await writer.delete("/api/admin/content/articles/rough-idea")).body).toEqual({ ok: true });
    expect(await Publication.exists({ slug: "rough-idea" })).toBeNull();

    // Arbitration (S10) is linked from other services.
    const linked = await admin.delete("/api/admin/content/services/arbitration");
    expect(linked.status).toBe(409);
    expect(linked.body.error).toBe("in_use");

    await Publication.updateOne({ type: "article" }, { status: "published" });
    expect((await admin.delete("/api/admin/content/articles/preparing-for-a-commercial-transaction")).body.error).toBe("not_a_draft");
  });

  it("preview bundle gives signed-in staff the drafts", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const res = await agent.get("/api/admin/preview-bundle");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.services.length).toBe(40);
  });
});
