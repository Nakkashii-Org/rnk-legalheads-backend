import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Enquiry } from "../src/models/Enquiry.js";
import { ORIGIN, clearDb, makeApp, startDb, stopDb } from "./helpers.js";

const valid = {
  name: "Élodie Ñúñez-O'Brien",
  email: "elodie@example.com",
  phone: "+91 98765 43210",
  organisation: "Acme Pvt Ltd",
  service: "arbitration",
  message: "We would like to discuss a proposed supply agreement with a distributor.",
  acknowledged: true,
  website: "",
};

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

describe("POST /api/contact", () => {
  it("saves the enquiry, emails the firm and returns a reference", async () => {
    const { app, mail } = await makeApp();
    const res = await request(app).post("/api/contact").set("Origin", ORIGIN).send(valid);
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^RNK-[A-Z0-9]{8}$/);

    const saved = await Enquiry.findOne({ reference: res.body.reference });
    expect(saved?.delivery?.status).toBe("sent");
    expect(saved?.service).toBe("arbitration");

    const email = mail.sent[0]!;
    expect(email.to[0]!.email).toBe("contact@rnklegalheads.com");
    expect(email.replyTo?.email).toBe("elodie@example.com");
    expect(email.subject).toBe(`Website enquiry ${res.body.reference}: Arbitration`);
    expect(email.text).toContain(valid.message);
  });

  it("escapes visitor text in the HTML email", async () => {
    const { app, mail } = await makeApp();
    await request(app)
      .post("/api/contact")
      .set("Origin", ORIGIN)
      .send({ ...valid, message: "<script>alert(1)</script> please call me about the contract terms" });
    expect(mail.sent[0]!.html).not.toContain("<script>");
    expect(mail.sent[0]!.html).toContain("&lt;script&gt;");
  });

  it("returns 422 with the same messages as the frontend", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/contact").set("Origin", ORIGIN).send({ name: "A", email: "bad", message: "short", service: "x" });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({
      name: "Enter your name.",
      email: "Enter an email address in the format name@example.com.",
      service: "Choose a service, General enquiry or Not sure.",
      message: "Describe the subject in at least 20 characters.",
      acknowledged: "Confirm that you have read the notice before sending.",
    });
    expect(await Enquiry.countDocuments()).toBe(0);
  });

  it("rejects line breaks in the name (header injection)", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/contact").set("Origin", ORIGIN).send({ ...valid, name: "Ana\nBcc: x@y.com" });
    expect(res.body.errors.name).toBe("Name must be on one line.");
  });

  it("does not offer a held service", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/contact").set("Origin", ORIGIN).send({ ...valid, service: "litigation-funding-advisory" });
    expect(res.status).toBe(422);
  });

  it("accepts General enquiry and keeps a person context", async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post("/api/contact")
      .set("Origin", ORIGIN)
      .send({ ...valid, service: "general-enquiry", context: { kind: "person", slug: "lawyer-profile-1" } });
    expect(res.status).toBe(201);
    const saved = await Enquiry.findOne({ reference: res.body.reference });
    expect(saved?.context?.slug).toBe("lawyer-profile-1");
  });

  it("answers the honeypot like a success but stores and sends nothing", async () => {
    const { app, mail } = await makeApp();
    const res = await request(app).post("/api/contact").set("Origin", ORIGIN).send({ ...valid, website: "http://spam" });
    expect(res.status).toBe(201);
    expect(await Enquiry.countDocuments()).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("keeps the enquiry and returns 503 when Brevo fails", async () => {
    const { app, mail } = await makeApp();
    mail.failSend = true;
    const res = await request(app).post("/api/contact").set("Origin", ORIGIN).send(valid);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "delivery_failed" });
    const saved = await Enquiry.findOne();
    expect(saved?.delivery?.status).toBe("failed");
    expect(saved?.delivery?.error).toBe("internal_error");
  });

  it("refuses requests from another website", async () => {
    const { app } = await makeApp();
    expect((await request(app).post("/api/contact").set("Origin", "https://evil.example").send(valid)).status).toBe(403);
    expect((await request(app).post("/api/contact").send(valid)).status).toBe(403);
  });

  it("rate-limits after 5 attempts", async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 5; i++) await request(app).post("/api/contact").set("Origin", ORIGIN).send(valid);
    const res = await request(app).post("/api/contact").set("Origin", ORIGIN).send(valid);
    expect(res.status).toBe(429);
  });

  it("rejects oversized and malformed bodies without details", async () => {
    const { app } = await makeApp();
    const big = await request(app).post("/api/contact").set("Origin", ORIGIN).send({ ...valid, message: "x".repeat(20_000) });
    expect(big.status).toBe(413);
    const bad = await request(app).post("/api/contact").set("Origin", ORIGIN).set("Content-Type", "application/json").send("{not json");
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at |stack/i);
  });
});

describe("GET /api/health", () => {
  it("reports ok without details", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
