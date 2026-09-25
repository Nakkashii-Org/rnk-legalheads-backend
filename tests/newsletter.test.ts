import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SubscriberToken } from "../src/models/SubscriberToken.js";
import { SubscriptionEvent } from "../src/models/SubscriptionEvent.js";
import { ORIGIN, clearDb, makeApp, startDb, stopDb, type FakeMail } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

const subscribe = (app: Parameters<typeof request>[0], body: object) =>
  request(app)
    .post("/api/subscribe")
    .set("Origin", ORIGIN)
    .send({ email: "Reader@Example.com", topics: ["business", "disputes"], consent: true, noticeVersion: "draft-2026-09", website: "", ...body });

const confirmToken = (mail: FakeMail) => new URL(mail.optIns.at(-1)!.redirectionUrl).searchParams.get("token")!;

describe("newsletter", () => {
  it("starts double opt-in with the chosen lists and a confirm link to our site", async () => {
    const { app, mail } = await makeApp();
    const res = await subscribe(app, {});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "pending" });
    const optIn = mail.optIns[0]!;
    expect(optIn.email).toBe("reader@example.com");
    expect(optIn.listIds).toEqual([1, 2]);
    expect(optIn.redirectionUrl).toMatch(/^http:\/\/localhost:3000\/subscribe\/confirm\?token=[A-Za-z0-9_-]{43}$/);

    // Only the hash is stored, with the consent record.
    const stored = await SubscriberToken.findOne({ purpose: "confirm" });
    expect(stored?.hash).not.toBe(confirmToken(mail));
    expect(stored?.noticeVersion).toBe("draft-2026-09");
    expect(stored?.consentAt).toBeInstanceOf(Date);
  });

  it("validates like the frontend", async () => {
    const { app } = await makeApp();
    const res = await subscribe(app, { email: "nope", topics: ["crypto"], consent: false });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({
      email: "Enter an email address in the format name@example.com.",
      topics: "Choose topics from the list.",
      consent: "Confirm that you agree to receive the legal updates you select.",
    });
  });

  it("503 when Brevo refuses, and no token is left behind", async () => {
    const { app, mail } = await makeApp();
    mail.failOptIn = true;
    expect((await subscribe(app, {})).status).toBe(503);
    expect(await SubscriberToken.countDocuments()).toBe(0);
  });

  it("confirm → preferences → change topics → unsubscribe", async () => {
    const { app, mail } = await makeApp();
    await subscribe(app, {});

    const confirm = await request(app).get(`/api/subscribe/confirm?token=${confirmToken(mail)}`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("confirmed");
    const manage = confirm.body.manageToken as string;
    expect(manage).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The manage token carries no topics; the consent record keeps the chosen ones.
    const manageDoc = await SubscriberToken.findOne({ purpose: "manage" }).lean();
    expect(manageDoc).not.toHaveProperty("topics");
    expect((await SubscriberToken.findOne({ purpose: "confirm" }).lean())?.topics).toEqual(["business", "disputes"]);

    const prefs = await request(app).get(`/api/preferences?token=${manage}`);
    expect(prefs.body).toEqual({ topics: ["business", "disputes"] });

    const save = await request(app).post("/api/preferences").set("Origin", ORIGIN).send({ token: manage, topics: ["tax"] });
    expect(save.status).toBe(200);
    expect(mail.contacts.get("reader@example.com")?.listIds).toEqual([3]);

    const empty = await request(app).post("/api/preferences").set("Origin", ORIGIN).send({ token: manage, topics: [] });
    expect(empty.status).toBe(422);

    const unsub = await request(app).post("/api/unsubscribe").set("Origin", ORIGIN).send({ token: manage });
    expect(unsub.body).toEqual({ status: "unsubscribed" });
    expect(mail.contacts.get("reader@example.com")?.listIds).toEqual([]);

    // Every step is in the consent history, in order.
    const history = await SubscriptionEvent.find({ email: "reader@example.com" }).sort({ at: 1, _id: 1 }).lean();
    expect(history.map((e) => [e.action, e.topics])).toEqual([
      ["subscribe_requested", ["business", "disputes"]],
      ["confirmed", ["business", "disputes"]],
      ["preferences_updated", ["tax"]],
      ["unsubscribed", []],
    ]);
    expect(history[0]!.noticeVersion).toBe("draft-2026-09");

    // Opening the confirm link again does not add a second "confirmed" entry.
    await request(app).get(`/api/subscribe/confirm?token=${confirmToken(mail)}`);
    expect(await SubscriptionEvent.countDocuments({ action: "confirmed" })).toBe(1);
  });

  it("does not confirm until Brevo has the contact", async () => {
    const { app, mail } = await makeApp();
    await subscribe(app, {});
    mail.contacts.clear();
    const res = await request(app).get(`/api/subscribe/confirm?token=${confirmToken(mail)}`);
    expect(res.status).toBe(409);
    expect(res.body.status).toBe("unconfirmed");
  });

  it("rejects unknown, malformed and expired tokens", async () => {
    const { app, mail } = await makeApp();
    expect((await request(app).get("/api/subscribe/confirm?token=AAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(410);
    expect((await request(app).get("/api/preferences?token=<script>")).status).toBe(410);
    expect((await request(app).post("/api/unsubscribe").set("Origin", ORIGIN).send({ token: "nope" })).status).toBe(410);

    await subscribe(app, {});
    await SubscriberToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await request(app).get(`/api/subscribe/confirm?token=${confirmToken(mail)}`)).status).toBe(410);
  });

  it("a confirm token cannot be used as a manage token", async () => {
    const { app, mail } = await makeApp();
    await subscribe(app, {});
    expect((await request(app).get(`/api/preferences?token=${confirmToken(mail)}`)).status).toBe(410);
  });

  it("honeypot: pending answer, nothing sent", async () => {
    const { app, mail } = await makeApp();
    expect((await subscribe(app, { website: "x" })).status).toBe(202);
    expect(mail.optIns).toHaveLength(0);
  });
});
