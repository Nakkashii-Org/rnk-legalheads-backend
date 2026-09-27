import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Application } from "../src/models/Application.js";
import { AuditEvent } from "../src/models/AuditEvent.js";
import { Enquiry } from "../src/models/Enquiry.js";
import { clearDb, makeApp, ORIGIN, signedInAgent as signIn, startDb, stopDb } from "./helpers.js";

const signedInAgent = async (...args: Parameters<typeof signIn>) => (await signIn(...args)).set("Origin", ORIGIN);
const PDF = Buffer.from("%PDF-1.4\n% test resume\n");

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

async function seedInbox(app: Awaited<ReturnType<typeof makeApp>>) {
  await Enquiry.create([
    { reference: "RNK-AAAAAAA1", name: "Asha Rao", email: "asha@example.com", service: "arbitration", message: "x".repeat(40), acknowledged: true },
    { reference: "RNK-AAAAAAA2", name: "Vikram Sen", email: "vikram@example.com", service: "tax", message: "y".repeat(40), acknowledged: true, status: "closed" },
  ]);
  const key = "resumes/2026/09/RNK-BBBBBBB1.pdf";
  await app.storage.put(key, PDF, "application/pdf");
  await Application.create({
    reference: "RNK-BBBBBBB1",
    name: "Meera Iyer",
    email: "meera@example.com",
    phone: "9876543210",
    city: "Delhi",
    position: "associate-disputes",
    experience: "3-5",
    qualification: "LLB",
    consent: true,
    resume: { storage: "local", key, originalName: "Meera CV.pdf", mimeType: "application/pdf", size: PDF.length, sha256: "x" },
  });
}

describe("Inbox (phase E)", () => {
  it("Publishers and Administrators only", async () => {
    const app = await makeApp();
    await seedInbox(app);
    const writer = await signedInAgent(app, "writer@example.com", ["contributor", "reviewer"]);
    for (const path of ["/api/admin/inbox/enquiries", "/api/admin/inbox/enquiries/RNK-AAAAAAA1", "/api/admin/inbox/applications/RNK-BBBBBBB1/resume"])
      expect((await writer.get(path)).status).toBe(403);
    expect((await request(app.app).get("/api/admin/inbox/enquiries")).status).toBe(401);
  });

  it("lists enquiries newest first with counts, filters and search", async () => {
    const app = await makeApp();
    await seedInbox(app);
    const publisher = await signedInAgent(app, "publisher@example.com", ["publisher"]);
    const all = await publisher.get("/api/admin/inbox/enquiries");
    expect(all.body.total).toBe(2);
    expect(all.body.counts).toEqual({ new: 1, "in-progress": 0, closed: 1 });
    expect(all.body.items[0]).not.toHaveProperty("message");
    expect((await publisher.get("/api/admin/inbox/enquiries?status=closed")).body.items.map((i: { name: string }) => i.name)).toEqual(["Vikram Sen"]);
    expect((await publisher.get("/api/admin/inbox/enquiries?q=asha")).body.items.map((i: { reference: string }) => i.reference)).toEqual(["RNK-AAAAAAA1"]);
    expect((await publisher.get("/api/admin/inbox/enquiries?q=" + encodeURIComponent("(.*"))).status).toBe(200);
    expect((await publisher.get("/api/admin/inbox/podcasts")).status).toBe(404);
  });

  it("opens one; status changes and internal notes are saved and audited", async () => {
    const app = await makeApp();
    await seedInbox(app);
    const publisher = await signedInAgent(app, "publisher@example.com", ["publisher"]);
    const one = await publisher.get("/api/admin/inbox/enquiries/RNK-AAAAAAA1");
    expect(one.body.item).toMatchObject({ reference: "RNK-AAAAAAA1", message: "x".repeat(40), notes: [] });
    expect(one.body.item).not.toHaveProperty("_id");

    expect((await publisher.patch("/api/admin/inbox/enquiries/RNK-AAAAAAA1").send({})).status).toBe(422);
    expect((await publisher.patch("/api/admin/inbox/enquiries/RNK-AAAAAAA1").send({ status: "archived" })).body.errors.status).toBeTruthy();
    const res = await publisher.patch("/api/admin/inbox/enquiries/RNK-AAAAAAA1").send({ status: "in-progress", note: "Called back; meeting on Monday." });
    expect(res.body.item).toMatchObject({ status: "in-progress", notes: [{ text: "Called back; meeting on Monday.", by: "publisher@example.com" }] });
    const event = await AuditEvent.findOne({ action: "enquiry.updated" }).lean();
    expect(event?.detail).toBe("status new → in-progress; note added");
    expect((await publisher.get("/api/admin/inbox/enquiries/RNK-XXXXXXXX")).status).toBe(404);
    expect((await publisher.get("/api/admin/inbox/enquiries/not-a-reference")).status).toBe(404);
  });

  it("applications: filter by position; the resume downloads only after sign-in, and is audited", async () => {
    const app = await makeApp();
    await seedInbox(app);
    const publisher = await signedInAgent(app, "publisher@example.com", ["publisher"]);
    const list = await publisher.get("/api/admin/inbox/applications?position=associate-disputes");
    expect(list.body.items[0]).toMatchObject({ reference: "RNK-BBBBBBB1", resume: { name: "Meera CV.pdf" } });
    expect(list.body.items[0].resume).not.toHaveProperty("key");
    expect(list.body.positions).toEqual(["associate-disputes"]);
    expect((await publisher.get("/api/admin/inbox/applications/RNK-BBBBBBB1")).body.item.resume).toEqual({ name: "Meera CV.pdf", size: PDF.length, type: "application/pdf" });

    const file = await publisher.get("/api/admin/inbox/applications/RNK-BBBBBBB1/resume").buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["content-disposition"]).toBe('attachment; filename="RNK-BBBBBBB1-Meera-Iyer.pdf"');
    expect(file.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.from(file.body).equals(PDF)).toBe(true);
    expect(await AuditEvent.countDocuments({ action: "application.resume_downloaded" })).toBe(1);
    expect((await request(app.app).get("/api/admin/inbox/applications/RNK-BBBBBBB1/resume")).status).toBe(401);
    expect((await publisher.get("/api/admin/inbox/enquiries/RNK-AAAAAAA1/resume")).status).toBe(404);
  });

  it("delete: Administrators only; the resume file is deleted too", async () => {
    const app = await makeApp();
    await seedInbox(app);
    const publisher = await signedInAgent(app, "publisher@example.com", ["publisher"]);
    const admin = await signedInAgent(app, "admin@example.com", ["admin"]);
    expect((await publisher.delete("/api/admin/inbox/applications/RNK-BBBBBBB1")).status).toBe(403);
    expect((await admin.delete("/api/admin/inbox/applications/RNK-BBBBBBB1")).body).toEqual({ ok: true });
    expect(await Application.countDocuments()).toBe(0);
    await expect(app.storage.get("resumes/2026/09/RNK-BBBBBBB1.pdf")).rejects.toThrow();
    expect(await AuditEvent.countDocuments({ action: "application.deleted" })).toBe(1);
  });
});
