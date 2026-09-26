import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BrevoProvider, ProviderError } from "../src/services/mail.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> };

function fakeFetch(responses: { status: number; body?: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const provider = (impl: typeof fetch) =>
  new BrevoProvider(
    { transport: "brevo", brevoApiKey: "xkeysib-test", fromEmail: "website@rnklegalheads.com", fromName: "RNK", contactDestination: "", careersDestination: "", attachResume: true, doiTemplateId: 7 },
    impl,
  );

describe("BrevoProvider request shapes (Brevo API v3)", () => {
  it("sends transactional email with the api-key header", async () => {
    const { impl, calls } = fakeFetch([{ status: 201, body: { messageId: "<abc@smtp>" } }]);
    const result = await provider(impl).sendEmail({
      to: [{ email: "contact@rnklegalheads.com" }],
      replyTo: { email: "a@b.com", name: "A" },
      subject: "S",
      text: "T",
      html: "<p>H</p>",
      attachments: [{ name: "cv.pdf", content: Buffer.from("PDF") }],
    });
    expect(result.messageId).toBe("<abc@smtp>");
    expect(calls[0]!.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(calls[0]!.headers["api-key"]).toBe("xkeysib-test");
    expect(calls[0]!.body).toMatchObject({
      sender: { email: "website@rnklegalheads.com", name: "RNK" },
      subject: "S",
      attachment: [{ name: "cv.pdf", content: Buffer.from("PDF").toString("base64") }],
    });
  });

  it("starts double opt-in with template and redirect", async () => {
    const { impl, calls } = fakeFetch([{ status: 201 }]);
    await provider(impl).startDoubleOptIn({ email: "r@e.com", listIds: [3], redirectionUrl: "https://site/subscribe/confirm?token=x" });
    expect(calls[0]!.url).toBe("https://api.brevo.com/v3/contacts/doubleOptinConfirmation");
    expect(calls[0]!.body).toEqual({ email: "r@e.com", includeListIds: [3], templateId: 7, redirectionUrl: "https://site/subscribe/confirm?token=x" });
  });

  it("reads and updates contacts by encoded email", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { listIds: [3, 4], emailBlacklisted: false } }, { status: 404, body: { code: "document_not_found" } }, { status: 204 }]);
    const p = provider(impl);
    expect(await p.getContact("a+b@e.com")).toEqual({ listIds: [3, 4], blacklisted: false });
    expect(calls[0]!.url).toBe("https://api.brevo.com/v3/contacts/a%2Bb%40e.com");
    expect(await p.getContact("none@e.com")).toBeUndefined();
    await p.updateContact("a@e.com", { linkListIds: [3], unlinkListIds: [4, 5] });
    expect(calls[2]!.method).toBe("PUT");
    expect(calls[2]!.body).toEqual({ listIds: [3], unlinkListIds: [4, 5] });
  });

  it("turns Brevo errors into ProviderError with status and code only", async () => {
    const { impl } = fakeFetch([{ status: 401, body: { code: "unauthorized", message: "Key not found" } }]);
    const error = await provider(impl).sendEmail({ to: [{ email: "x@y.z" }], subject: "", text: "", html: "" }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("config", () => {
  it("refuses development transports in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", PUBLIC_SITE_URL: "https://rnk.example", MONGODB_URI: "mongodb://x", CONTACT_DESTINATION: "c@x.com", MAIL_TRANSPORT: "log", STORAGE_DRIVER: "local" }),
    ).toThrow(/MAIL_TRANSPORT=log is not allowed[\s\S]*STORAGE_DRIVER=local is not allowed/);
  });

  it("lists every missing production setting", () => {
    try {
      loadConfig({ NODE_ENV: "production" });
    } catch (error) {
      const message = (error as Error).message;
      for (const name of ["PUBLIC_SITE_URL", "MONGODB_URI", "BREVO_API_KEY", "MAIL_FROM_EMAIL", "NEWSLETTER_LIST_IDS", "DOI_TEMPLATE_ID", "S3_BUCKET", "CONTACT_DESTINATION", "MFA_ENCRYPTION_KEY"])
        expect(message).toContain(name);
      return;
    }
    throw new Error("expected loadConfig to throw");
  });
});
