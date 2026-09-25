import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Application } from "../src/models/Application.js";
import { ORIGIN, clearDb, makeApp, startDb, stopDb } from "./helpers.js";

const PDF = Buffer.from("%PDF-1.4\n% test resume\n");
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....word/document.xml....")]);

const fields: Record<string, string> = {
  name: "Ananya Sharma",
  email: "ananya@example.com",
  phone: "98765 43210",
  city: "New Delhi",
  position: "associate",
  experience: "2-5",
  qualification: "LL.B.",
  barEnrolment: "",
  organisation: "",
  linkedin: "https://www.linkedin.com/in/ananya",
  coverNote: "I am interested in disputes work.",
  consent: "true",
  website: "",
};

function post(app: Parameters<typeof request>[0], overrides: Record<string, string> = {}, file?: { buffer: Buffer; name: string } | null) {
  const req = request(app).post("/api/careers").set("Origin", ORIGIN);
  for (const [k, v] of Object.entries({ ...fields, ...overrides })) req.field(k, v);
  if (file !== null) req.attach("resume", file?.buffer ?? PDF, file?.name ?? "Ananya_Resume.pdf");
  return req;
}

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

describe("POST /api/careers", () => {
  it("stores the resume privately, saves the application and emails HR", async () => {
    const { app, mail, storage } = await makeApp({ CAREERS_DESTINATION: "careers@rnklegalheads.com" });
    const res = await post(app);
    expect(res.status).toBe(201);
    const ref = res.body.reference;
    expect(ref).toMatch(/^RNK-[A-Z0-9]{8}$/);

    expect(storage.keys[0]).toMatch(new RegExp(`^resumes/\\d{4}/\\d{2}/${ref}\\.pdf$`));
    const saved = await Application.findOne({ reference: ref });
    expect(saved?.resume?.mimeType).toBe("application/pdf");
    expect(saved?.resume?.storage).toBe("local");
    expect(saved?.resume?.sha256).toHaveLength(64);
    expect(saved?.delivery?.status).toBe("sent");

    const email = mail.sent[0]!;
    expect(email.to[0]!.email).toBe("careers@rnklegalheads.com");
    expect(email.subject).toBe(`Job application ${ref}: Associate`);
    expect(email.attachments?.[0]?.name).toBe(`Ananya_Sharma_${ref}.pdf`);
  });

  it("accepts DOCX and a vacancy slug", async () => {
    const { app } = await makeApp();
    const res = await post(app, { position: "senior-associate-disputes" }, { buffer: DOCX, name: "cv.docx" });
    expect(res.status).toBe(201);
  });

  it("can send the email without the attachment", async () => {
    const { app, mail } = await makeApp({ ATTACH_RESUME_TO_EMAIL: "false" });
    await post(app);
    expect(mail.sent[0]!.attachments).toBeUndefined();
  });

  it("requires a resume", async () => {
    const { app } = await makeApp();
    const res = await post(app, {}, null);
    expect(res.status).toBe(422);
    expect(res.body.errors.resume).toBe("Upload your resume.");
  });

  it("checks the file contents, not just the name", async () => {
    const { app } = await makeApp();
    const fake = await post(app, {}, { buffer: Buffer.from("MZ executable"), name: "resume.pdf" });
    expect(fake.body.errors.resume).toBe("The resume must be a PDF, DOC or DOCX file.");
    const txt = await post(app, {}, { buffer: Buffer.from("hello"), name: "resume.txt" });
    expect(txt.body.errors.resume).toBe("The resume must be a PDF, DOC or DOCX file.");
  });

  it("rejects files over 5 MB", async () => {
    const { app } = await makeApp();
    const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024 + 10, 1)]);
    const res = await post(app, {}, { buffer: big, name: "big.pdf" });
    expect(res.status).toBe(422);
    expect(res.body.errors.resume).toBe("The resume must be 5 MB or smaller.");
  });

  it("returns field errors like the frontend", async () => {
    const { app } = await makeApp();
    const res = await post(app, { phone: "12345", linkedin: "linkedin profile", experience: "", consent: "false" });
    expect(res.body.errors).toMatchObject({
      phone: "Enter a 10-digit mobile number, or + and the country code.",
      linkedin: "Enter the full profile link, starting with https://",
      experience: "Choose your experience.",
      consent: "Confirm that your details may be used for recruitment.",
    });
    expect(await Application.countDocuments()).toBe(0);
  });

  it("returns 503 and saves nothing when storage fails", async () => {
    const { app, storage } = await makeApp();
    storage.fail = true;
    const res = await post(app);
    expect(res.status).toBe(503);
    expect(await Application.countDocuments()).toBe(0);
  });

  it("keeps the application and returns 503 when the email fails", async () => {
    const { app, mail } = await makeApp();
    mail.failSend = true;
    const res = await post(app);
    expect(res.status).toBe(503);
    expect((await Application.findOne())?.delivery?.status).toBe("failed");
  });

  it("requires multipart form data", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/careers").set("Origin", ORIGIN).send({ name: "x" });
    expect(res.status).toBe(415);
  });

  it("honeypot: success-looking answer, nothing stored", async () => {
    const { app, storage } = await makeApp();
    const res = await post(app, { website: "spam" });
    expect(res.status).toBe(201);
    expect(storage.keys).toHaveLength(0);
    expect(await Application.countDocuments()).toBe(0);
  });
});
