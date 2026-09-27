import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Enquiry } from "../src/models/Enquiry.js";
import { Publication } from "../src/models/content/Publication.js";
import { Service } from "../src/models/content/Service.js";
import { seedContent } from "../src/scripts/seed-content.js";
import { clearDb, makeApp, signedInAgent, startDb, stopDb } from "./helpers.js";

const SEED = JSON.parse(readFileSync(new URL("../seed/content.json", import.meta.url), "utf8"));

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedContent(SEED);
});

describe("CMS reading (C1)", () => {
  it("needs a signed-in user", async () => {
    const app = await makeApp();
    for (const path of ["/api/admin/dashboard", "/api/admin/content/services", "/api/admin/content/services/arbitration", "/api/admin/options"])
      expect((await request(app.app).get(path)).status).toBe(401);
  });

  it("lists every record of a type, with status filter and search", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const all = await agent.get("/api/admin/content/services");
    expect(all.body.total).toBe(40);
    expect(all.body.items).toHaveLength(40);
    expect(all.body.items[0]).toMatchObject({ type: "services", status: "draft" });

    await Service.updateOne({ slug: "arbitration" }, { status: "in_review" });
    const inReview = await agent.get("/api/admin/content/services?status=in_review");
    expect(inReview.body.items.map((i: { id: string }) => i.id)).toEqual(["arbitration"]);

    const search = await agent.get("/api/admin/content/services?q=arbitr");
    expect(search.body.items.map((i: { id: string }) => i.id)).toEqual(["arbitration"]);
    expect((await agent.get("/api/admin/content/services?q=" + encodeURIComponent("(.*"))).status).toBe(200);
    expect((await agent.get("/api/admin/content/podcasts")).status).toBe(404);
  });

  it("publication types are kept apart; rows carry author and details", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const judgments = await agent.get("/api/admin/content/judgments");
    expect(judgments.body.items).toHaveLength(1);
    expect(judgments.body.items[0]).toMatchObject({ id: "a-structured-note-on-a-recent-decision", preview: true, author: "Approved lawyer", detail: "Court or tribunal" });
    expect((await agent.get("/api/admin/content/services")).body.items.find((i: { id: string }) => i.id === "litigation-funding-advisory").detail).toContain("Publication hold");
  });

  it("returns one full record for the editor, without database internals", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const res = await agent.get("/api/admin/content/services/arbitration");
    expect(res.body.summary).toMatchObject({ id: "arbitration", title: "Arbitration", status: "draft" });
    expect(res.body.record).toMatchObject({ serviceId: "S10", group: "disputes", related: ["S09", "S23", "S17"] });
    expect(res.body.record.scope).toHaveLength(6);
    expect(res.body.record).not.toHaveProperty("_id");
    expect((await agent.get("/api/admin/content/articles/nope")).status).toBe(404);
    expect((await agent.get("/api/admin/content/judgments/preparing-for-a-commercial-transaction")).status).toBe(404);
  });

  it("review queue: records of every type with a given status", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "reviewer@example.com", ["reviewer"]);
    await Service.updateOne({ slug: "arbitration" }, { status: "in_review" });
    await Publication.updateOne({ type: "article" }, { status: "in_review" });
    const res = await agent.get("/api/admin/content?status=in_review");
    expect(res.body.items.map((i: { type: string; id: string }) => `${i.type}/${i.id}`).sort()).toEqual([
      "articles/preparing-for-a-commercial-transaction",
      "services/arbitration",
    ]);
    expect((await agent.get("/api/admin/content")).status).toBe(422);
  });

  it("dashboard: real counts; inbox counts only for Publisher and Administrator", async () => {
    const app = await makeApp();
    await Enquiry.create({ reference: "RNK-AAAAAAAA", name: "A B", email: "a@b.co", service: "arbitration", message: "x".repeat(30), acknowledged: true });
    await Service.updateOne({ slug: "arbitration" }, { status: "published" });

    const writer = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const w = await writer.get("/api/admin/dashboard");
    expect(w.body.total).toBe(62);
    expect(w.body.counts).toMatchObject({ draft: 61, published: 1, in_review: 0 });
    expect(w.body.recentDrafts.length).toBeGreaterThan(0);
    expect(w.body.recentDrafts.every((r: { status: string }) => r.status === "draft")).toBe(true);
    expect(w.body.reviewRequests).toEqual([]);
    expect(w.body.inbox).toBeNull();

    const publisher = await signedInAgent(app, "publisher@example.com", ["publisher"]);
    expect((await publisher.get("/api/admin/dashboard")).body.inbox).toEqual({ enquiries: 1, applications: 0 });
  });

  it("dashboard: review requests list in-review and changes-requested records of every type", async () => {
    const app = await makeApp();
    await Service.updateOne({ slug: "arbitration" }, { status: "in_review" });
    await Publication.updateOne({ type: "article" }, { status: "changes_requested" });
    const agent = await signedInAgent(app, "reviewer@example.com", ["reviewer"]);
    const res = await agent.get("/api/admin/dashboard");
    expect(res.body.counts).toMatchObject({ draft: 60, in_review: 1, changes_requested: 1 });
    expect(res.body.reviewRequests.map((r: { type: string; status: string }) => `${r.type}:${r.status}`).sort()).toEqual(["articles:changes_requested", "services:in_review"]);
    expect(res.body.recentDrafts.some((r: { id: string }) => r.id === "preparing-for-a-commercial-transaction")).toBe(false);
  });

  it("options for the editor pickers use service ids, people slugs and type:slug", async () => {
    const app = await makeApp();
    const agent = await signedInAgent(app, "writer@example.com", ["contributor"]);
    const res = await agent.get("/api/admin/options");
    expect(res.body.services).toHaveLength(40);
    expect(res.body.services.find((s: { value: string }) => s.value === "S10").label).toBe("Arbitration");
    expect(res.body.people.map((p: { value: string }) => p.value)).toContain("lawyer-profile-1");
    expect(res.body.publications.map((p: { value: string }) => p.value)).toContain("judgment:a-structured-note-on-a-recent-decision");
  });
});
