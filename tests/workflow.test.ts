import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Publication } from "../src/models/content/Publication.js";
import { ReviewEvent } from "../src/models/ReviewEvent.js";
import { SubscriptionEvent } from "../src/models/SubscriptionEvent.js";
import { seedContent } from "../src/scripts/seed-content.js";
import { clearDb, makeApp, ORIGIN, signedInAgent as signIn, startDb, stopDb } from "./helpers.js";

const SEED = JSON.parse(readFileSync(new URL("../seed/content.json", import.meta.url), "utf8"));
const signedInAgent = async (...args: Parameters<typeof signIn>) => (await signIn(...args)).set("Origin", ORIGIN);
type Agent = Awaited<ReturnType<typeof signedInAgent>>;

const ALL = [true, true, true, true, true, true];
const person = { name: "Lawyer profile 1", slug: "lawyer-profile-1", role: "Partner", practiceSummary: "Commercial disputes.", biography: "<p>Biography.</p>" };
const article = { title: "Live article", slug: "live-article", summary: "Summary.", body: "<p>Body.</p>", author: ["lawyer-profile-1"] };

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedContent(SEED);
});

async function team() {
  const app = await makeApp();
  return {
    app,
    writer: await signedInAgent(app, "writer@example.com", ["contributor"]),
    reviewer: await signedInAgent(app, "reviewer@example.com", ["reviewer"]),
    publisher: await signedInAgent(app, "publisher@example.com", ["publisher"]),
    admin: await signedInAgent(app, "admin@example.com", ["admin"]),
  };
}

async function goLive(t: Awaited<ReturnType<typeof team>>, type: string, id: string, values: object) {
  expect((await t.writer.post(`/api/admin/content/${type}/${id}/submit`).send({ values })).status).toBe(200);
  expect((await t.reviewer.post(`/api/admin/content/${type}/${id}/approve`).send({ checklist: ALL })).status).toBe(200);
  const res = await t.publisher.post(`/api/admin/content/${type}/${id}/publish`);
  expect(res.status).toBe(200);
  return res;
}

const publicBundle = async (app: Awaited<ReturnType<typeof makeApp>>) => (await request(app.app).get("/api/content/bundle")).body;
const status = async (agent: Agent, type: string, id: string) => (await agent.get(`/api/admin/content/${type}/${id}`)).body.summary.status;

describe("Review (D1)", () => {
  it("only reviewers approve; the full checklist is needed; nobody approves their own changes", async () => {
    const t = await team();
    await t.writer.post("/api/admin/content/people/lawyer-profile-1/submit").send({ values: person }).expect(200);
    const url = "/api/admin/content/people/lawyer-profile-1/approve";

    expect((await t.writer.post(url).send({ checklist: ALL })).status).toBe(403);
    expect((await t.publisher.post(url).send({ checklist: ALL })).status).toBe(403);
    expect((await t.reviewer.post(url).send({ checklist: [true, true, true, true, true, false] })).body.errors.checklist).toBeTruthy();

    const writerReviewer = await signedInAgent(t.app, "both@example.com", ["contributor", "reviewer"]);
    await writerReviewer.patch("/api/admin/content/people/lawyer-profile-1").send({ values: person });
    await writerReviewer.post("/api/admin/content/people/lawyer-profile-1/submit").send({ values: person });
    const own = await writerReviewer.post(url).send({ checklist: ALL });
    expect(own.status).toBe(403);
    expect(own.body.error).toBe("own_revision");

    const ok = await t.reviewer.post(url).send({ checklist: ALL, comment: "Checked against the enrolment record." });
    expect(ok.body).toMatchObject({ status: "approved" });
    expect(await status(t.admin, "people", "lawyer-profile-1")).toBe("approved");
  });

  it("request changes needs a comment; the writer sees it in the history", async () => {
    const t = await team();
    await t.writer.post("/api/admin/content/people/lawyer-profile-1/submit").send({ values: person });
    const url = "/api/admin/content/people/lawyer-profile-1/request-changes";
    expect((await t.reviewer.post(url).send({ comment: "short" })).status).toBe(422);
    expect((await t.reviewer.post(url).send({ comment: "Please add the enrolment number." })).body.status).toBe("changes_requested");
    const history = await t.writer.get("/api/admin/content/people/lawyer-profile-1/revisions");
    expect(history.body.events[0]).toMatchObject({ action: "changes_requested", comment: "Please add the enrolment number.", by: "reviewer@example.com" });
  });

  it("reject archives a never-published record; its creator or an Administrator restores it", async () => {
    const t = await team();
    await t.writer.post("/api/admin/content/articles").send({ values: article }).expect(201);
    await t.writer.post("/api/admin/content/articles/live-article/submit").send({ values: article }).expect(200);
    expect((await t.reviewer.post("/api/admin/content/articles/live-article/reject").send({ comment: "Not a topic we publish on." })).body.status).toBe("archived");
    expect((await t.writer.patch("/api/admin/content/articles/live-article").send({ values: article })).status).toBe(409);
    expect((await t.publisher.post("/api/admin/content/articles/live-article/restore")).status).toBe(403);
    expect((await t.writer.post("/api/admin/content/articles/live-article/restore")).body.status).toBe("draft");
  });
});

describe("Publish (D2)", () => {
  it("only an approved revision is published, by a publisher; an article waits for its author's profile", async () => {
    const t = await team();
    await t.writer.post("/api/admin/content/articles").send({ values: article }).expect(201);
    await t.writer.post("/api/admin/content/articles/live-article/submit").send({ values: article });
    expect((await t.publisher.post("/api/admin/content/articles/live-article/publish")).body.error).toBe("not_approved");
    await t.reviewer.post("/api/admin/content/articles/live-article/approve").send({ checklist: ALL }).expect(200);
    expect((await t.reviewer.post("/api/admin/content/articles/live-article/publish")).status).toBe(403);

    const blocked = await t.publisher.post("/api/admin/content/articles/live-article/publish");
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain("isn't published yet");

    await goLive(t, "people", "lawyer-profile-1", person);
    const res = await t.publisher.post("/api/admin/content/articles/live-article/publish");
    expect(res.body).toMatchObject({ status: "published", live: true });

    const site = await publicBundle(t.app);
    const live = site.publications.find((p: { slug: string }) => p.slug === "live-article");
    expect(live).toMatchObject({ title: "Live article", approved: true, publishedAt: new Date().toISOString().slice(0, 10) });
    expect(site.people.map((p: { slug: string }) => p.slug)).toContain("lawyer-profile-1");
  });

  it("editing a published record keeps the live version until the new revision is approved and published", async () => {
    const t = await team();
    await goLive(t, "people", "lawyer-profile-1", person);
    await t.writer.post("/api/admin/content/articles").send({ values: article }).expect(201);
    await goLive(t, "articles", "live-article", article);

    const edited = { ...article, title: "Live article, corrected" };
    const saved = await t.writer.patch("/api/admin/content/articles/live-article").send({ values: edited });
    expect(saved.body.status).toBe("draft");
    let site = await publicBundle(t.app);
    expect(site.publications.find((p: { slug: string }) => p.slug === "live-article").title).toBe("Live article");

    const preview = await t.writer.get("/api/admin/preview-bundle");
    expect(preview.body.publications.find((p: { slug: string }) => p.slug === "live-article").title).toBe("Live article, corrected");

    await goLive(t, "articles", "live-article", edited);
    site = await publicBundle(t.app);
    const live = site.publications.find((p: { slug: string }) => p.slug === "live-article");
    expect(live.title).toBe("Live article, corrected");
    expect(live.updatedAt).toBe(new Date().toISOString().slice(0, 10));
  });

  it("unpublish removes it from the website; a profile named as author can't be unpublished first", async () => {
    const t = await team();
    await goLive(t, "people", "lawyer-profile-1", person);
    await t.writer.post("/api/admin/content/articles").send({ values: article }).expect(201);
    await goLive(t, "articles", "live-article", article);

    const blocked = await t.publisher.post("/api/admin/content/people/lawyer-profile-1/unpublish");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("in_use");

    expect((await t.publisher.post("/api/admin/content/articles/live-article/unpublish")).body).toMatchObject({ status: "unpublished", live: false });
    expect((await publicBundle(t.app)).publications.some((p: { slug: string }) => p.slug === "live-article")).toBe(false);
    // The same approved revision can go back up without another review.
    expect((await t.publisher.post("/api/admin/content/articles/live-article/publish")).body.status).toBe("published");
    expect(await ReviewEvent.countDocuments({ action: "published" })).toBe(3);
  });

  it("a published record that was never changed can't be sent for review again", async () => {
    const t = await team();
    await goLive(t, "people", "lawyer-profile-1", person);
    const res = await t.writer.post("/api/admin/content/people/lawyer-profile-1/submit").send({ values: person });
    expect(res.status).toBe(409);
  });
});

describe("Newsletter issues and Brevo (D3)", () => {
  it("an issue publishes only with published publications; the email draft needs a live issue and is made once", async () => {
    const t = await team();
    await goLive(t, "people", "lawyer-profile-1", person);
    await t.writer.post("/api/admin/content/articles").send({ values: article }).expect(201);
    const issue = { title: "October issue", slug: "october-issue", issueDate: "2026-10-01", introduction: "This month.", items: ["article:live-article"] };
    await t.writer.post("/api/admin/content/newsletters").send({ values: issue }).expect(201);

    expect((await t.publisher.post("/api/admin/content/newsletters/october-issue/email-draft")).body.error).toBe("not_live");
    await t.writer.post("/api/admin/content/newsletters/october-issue/submit").send({ values: issue }).expect(200);
    await t.reviewer.post("/api/admin/content/newsletters/october-issue/approve").send({ checklist: ALL }).expect(200);
    const blocked = await t.publisher.post("/api/admin/content/newsletters/october-issue/publish");
    expect(blocked.body.message).toContain("live-article");

    await goLive(t, "articles", "live-article", article);
    await t.publisher.post("/api/admin/content/newsletters/october-issue/publish").expect(200);
    expect(t.app.mail.sent.filter((m) => m.subject.includes("October"))).toHaveLength(0);

    expect((await t.writer.post("/api/admin/content/newsletters/october-issue/email-draft")).status).toBe(403);
    const draft = await t.publisher.post("/api/admin/content/newsletters/october-issue/email-draft");
    expect(draft.body.campaignId).toBe("log-campaign-1");
    const campaign = t.app.mail.campaigns[0]!;
    expect(campaign.subject).toBe("October issue");
    expect(campaign.html).toContain("/articles/live-article");
    expect(campaign.html).toContain("{{ unsubscribe }}");
    expect(campaign.html).toContain("/preferences?token={{ contact.MANAGE_TOKEN }}");
    expect(campaign.listIds.length).toBeGreaterThan(0);
    expect((await t.publisher.post("/api/admin/content/newsletters/october-issue/email-draft")).body.error).toBe("exists");
    expect((await publicBundle(t.app)).newsletters.map((n: { slug: string }) => n.slug)).toContain("october-issue");
  });

  it("the Brevo webhook needs its secret and records unsubscribes, bounces and complaints", async () => {
    const off = await makeApp();
    expect((await request(off.app).post("/api/webhooks/brevo").send({ event: "spam", email: "a@b.co" })).status).toBe(404);

    const secret = "a-long-random-webhook-secret-123";
    const { app } = await makeApp({ BREVO_WEBHOOK_SECRET: secret });
    expect((await request(app).post("/api/webhooks/brevo?token=wrong").send({ event: "spam", email: "a@b.co" })).status).toBe(401);
    const res = await request(app)
      .post(`/api/webhooks/brevo?token=${secret}`)
      .send([
        { event: "unsubscribe", email: "One@Example.com" },
        { event: "hard_bounce", email: "two@example.com" },
        { event: "spam", email: "three@example.com" },
        { event: "opened", email: "four@example.com" },
      ]);
    expect(res.body).toEqual({ ok: true, recorded: 3 });
    const events = await SubscriptionEvent.find({ source: "brevo" }).sort({ email: 1 }).lean();
    expect(events.map((e) => `${e.email}:${e.action}`)).toEqual(["one@example.com:unsubscribed", "three@example.com:complained", "two@example.com:bounced"]);
    expect(await Publication.countDocuments({ campaignId: { $exists: true } })).toBe(0);
  });
});
