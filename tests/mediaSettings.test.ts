import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditEvent } from "../src/models/AuditEvent.js";
import { Media } from "../src/models/Media.js";
import { Person } from "../src/models/content/Person.js";
import { SiteSettings } from "../src/models/content/SiteSettings.js";
import { seedContent } from "../src/scripts/seed-content.js";
import { sniffImage } from "../src/services/images.js";
import { clearDb, makeApp, ORIGIN, signedInAgent as signIn, startDb, stopDb } from "./helpers.js";

const SEED = JSON.parse(readFileSync(new URL("../seed/content.json", import.meta.url), "utf8"));
const signedInAgent = async (...args: Parameters<typeof signIn>) => (await signIn(...args)).set("Origin", ORIGIN);

// A real 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const meta = (extra: Record<string, unknown> = {}) => JSON.stringify({ title: "Office", alt: "The office entrance", credit: "RNK", licence: "own", ...extra });

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedContent(SEED);
});

describe("Media library (C4)", () => {
  it("recognises images by their bytes, not their name", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from("<svg onload=alert(1)></svg>....."))).toBeUndefined();
  });

  it("needs a signed-in user", async () => {
    const app = await makeApp();
    expect((await request(app.app).get("/api/admin/media")).status).toBe(401);
    expect((await request(app.app).post("/api/admin/media").set("Origin", ORIGIN).attach("files", PNG, "a.png")).status).toBe(401);
  });

  it("uploads with title, alt text, credit and licence; serves the file; lists it", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const res = await agent.post("/api/admin/media").attach("files", PNG, "office.png").field("meta[0]", meta());
    expect(res.status).toBe(201);
    const item = res.body.items[0];
    expect(item).toMatchObject({ title: "Office", alt: "The office entrance", licence: "own", uploadedBy: "writer@example.com", contentType: "image/png" });
    expect(item.url).toMatch(/^\/api\/media-files\/media\/\d{4}\/\d{2}\/[\w-]+\.png$/);
    const file = await request(app.app).get(item.url);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");

    const list = await agent.get("/api/admin/media");
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].usedBy).toEqual([]);
    expect(await AuditEvent.countDocuments({ action: "media.uploaded" })).toBe(1);
  });

  it("refuses non-images and missing details; nothing is stored", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const res = await agent
      .post("/api/admin/media")
      .attach("files", PNG, "ok.png")
      .field("meta[0]", meta())
      .attach("files", Buffer.from("<html><script>alert(1)</script></html>"), "fake.png")
      .field("meta[1]", meta())
      .attach("files", PNG, "no-alt.png")
      .field("meta[2]", meta({ alt: "" }));
    expect(res.status).toBe(422);
    expect(res.body.errors["1"]).toContain("not a JPG, PNG, WebP or AVIF");
    expect(res.body.errors["2"]).toBe("Add alt text, or mark the image as decorative.");
    expect(await Media.countDocuments()).toBe(0);
  });

  it("a portrait is chosen from the library; its alt follows edits; it can't be deleted while used", async () => {
    const app = await makeApp();
    const writer = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const admin = await signedInAgent(app, "admin@example.com", ["admin"]);
    const id = (await writer.post("/api/admin/media").attach("files", PNG, "p.png").field("meta[0]", meta({ title: "Portrait", licence: "consent" }))).body.items[0].id;

    const values = { name: "Lawyer profile 1", slug: "lawyer-profile-1", portrait: id };
    const saved = await writer.patch("/api/admin/content/people/lawyer-profile-1").send({ values });
    expect(saved.status).toBe(200);
    expect((await Person.findOne({ slug: "lawyer-profile-1" }).lean())?.portrait).toMatchObject({ mediaId: id, alt: "The office entrance" });

    const review = await writer.post("/api/admin/content/people/lawyer-profile-1/submit").send({ values });
    expect(review.body.errors.portraitConsent).toContain("consented");

    await writer.patch(`/api/admin/media/${id}`).send({ title: "Portrait", alt: "Portrait of the lawyer", credit: "RNK", licence: "consent" }).expect(200);
    expect((await Person.findOne({ slug: "lawyer-profile-1" }).lean())?.portrait?.alt).toBe("Portrait of the lawyer");

    const inUse = await admin.delete(`/api/admin/media/${id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.message).toContain("Portrait of Lawyer profile 1");

    const bad = await writer.patch("/api/admin/content/people/lawyer-profile-1").send({ values: { ...values, portrait: "0123456789abcdef01234567" } });
    expect(bad.body.errors.portrait).toContain("no longer exists");
  });

  it("delete: only the uploader or an Administrator; the file goes too", async () => {
    const app = await makeApp();
    const writer = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const other = await signedInAgent(app, "other@example.com", ["publisher"]);
    const item = (await writer.post("/api/admin/media").attach("files", PNG, "x.png").field("meta[0]", meta())).body.items[0];
    expect((await other.delete(`/api/admin/media/${item.id}`)).status).toBe(403);
    expect((await writer.delete(`/api/admin/media/${item.id}`)).body).toEqual({ ok: true });
    expect((await request(app.app).get(item.url)).status).toBe(404);
    expect(await Media.countDocuments()).toBe(0);
  });

  it("an article image reaches the website (staff preview) with its alt text", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const id = (await agent.post("/api/admin/media").attach("files", PNG, "a.png").field("meta[0]", meta())).body.items[0].id;
    await agent.post("/api/admin/content/articles").send({ values: { title: "With image", slug: "with-image", image: id } }).expect(201);
    const bundle = await agent.get("/api/admin/preview-bundle");
    const article = bundle.body.publications.find((p: { slug: string }) => p.slug === "with-image");
    expect(article.image).toEqual({ src: expect.stringMatching(/^\/api\/media-files\//), alt: "The office entrance" });
  });

  it("the editor options list library images", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    await agent.post("/api/admin/media").attach("files", PNG, "x.png").field("meta[0]", meta());
    const res = await agent.get("/api/admin/options");
    expect(res.body.media[0]).toMatchObject({ label: "Office", alt: "The office entrance" });
  });
});

describe("Long articles", () => {
  it("an article body larger than 16 KB saves", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const body = "<p>" + "A long paragraph of legal analysis. ".repeat(2000) + "</p>";
    const res = await agent.post("/api/admin/content/articles").send({ values: { title: "Long", slug: "long", body } });
    expect(res.status).toBe(201);
  });
});

describe("Site settings (C5)", () => {
  const valid = {
    name: "RNK Legalheads",
    legalEntity: "RNK Legalheads LLP",
    established: "2024",
    statement: "A full-service law firm.",
    disclaimer: "Nothing here is legal advice.",
    address: "1 Example Road\nNew Delhi",
    phone: "+91 11 1234 5678",
    email: "contact@rnklegalheads.com",
    mapQuery: "RNK Legalheads New Delhi",
    grievanceContact: "Data Protection Officer",
  };

  it("Administrators only", async () => {
    const app = await makeApp();
    const writer = await signedInAgent(app, "writer@example.com", ["contributor", "publisher"]);
    expect((await writer.get("/api/admin/settings")).status).toBe(403);
    expect((await writer.patch("/api/admin/settings").send(valid)).status).toBe(403);
  });

  it("saves checked values; the website bundle shows them; the audit log lists what changed", async () => {
    const app = await makeApp();
    const admin = await signedInAgent(app, "admin@example.com", ["admin"]);
    const bad = await admin.patch("/api/admin/settings").send({ ...valid, email: "nope", established: "2099", statement: "", phone: "call me" });
    expect(Object.keys(bad.body.errors).sort()).toEqual(["email", "established", "phone", "statement"]);

    const res = await admin.patch("/api/admin/settings").send(valid);
    expect(res.body.settings).toMatchObject({ address: valid.address, email: valid.email });
    expect((await SiteSettings.findOne({ key: "site" }).lean())?.established).toBe(2024);

    const bundle = await request(app.app).get("/api/content/bundle");
    expect(bundle.body.site).toMatchObject({ statement: valid.statement, contactDetails: { phone: valid.phone, address: valid.address } });
    const event = await AuditEvent.findOne({ action: "settings.updated" }).lean();
    expect(event?.detail).toContain("statement");
    expect(bundle.body.site.grievanceContact).toBe("Data Protection Officer");

    // Emptying an optional field removes it.
    await admin.patch("/api/admin/settings").send({ ...valid, grievanceContact: "" }).expect(200);
    expect((await SiteSettings.findOne({ key: "site" }).lean())?.grievanceContact).toBeUndefined();
  });
});
