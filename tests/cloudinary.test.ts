import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CloudinaryStorage } from "../src/services/storage.js";

describe("CloudinaryStorage", () => {
  it("signs exactly like Cloudinary's documented example", () => {
    // From Cloudinary's "Generating authentication signatures" guide.
    const signature = CloudinaryStorage.sign(
      { eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: "1315060510" },
      "abcd",
    );
    expect(signature).toBe("bfd09f95f331f558cbd1320e67aa8d488770583e");
  });

  it("uploads the resume as a private (authenticated) raw file", async () => {
    let url = "";
    let form: FormData | undefined;
    const fakeFetch = (async (u: string, init: RequestInit) => {
      url = u;
      form = init.body as FormData;
      return new Response(JSON.stringify({ public_id: "resumes/2026/09/RNK-TEST0001.pdf" }), { status: 200 });
    }) as unknown as typeof fetch;

    const storage = new CloudinaryStorage({ cloudName: "rnkdemo", apiKey: "123456", apiSecret: "shh" }, fakeFetch);
    await storage.put("resumes/2026/09/RNK-TEST0001.pdf", Buffer.from("%PDF-1.4 test"), "application/pdf");

    expect(url).toBe("https://api.cloudinary.com/v1_1/rnkdemo/raw/upload");
    expect(form!.get("type")).toBe("authenticated");
    expect(form!.get("public_id")).toBe("resumes/2026/09/RNK-TEST0001.pdf");
    expect(form!.get("api_key")).toBe("123456");
    const params = { public_id: String(form!.get("public_id")), timestamp: String(form!.get("timestamp")), type: "authenticated" };
    expect(form!.get("signature")).toBe(CloudinaryStorage.sign(params, "shh"));
    expect(form!.has("api_secret")).toBe(false);
    expect(await (form!.get("file") as Blob).text()).toBe("%PDF-1.4 test");
  });

  it("reports Cloudinary errors without the secret", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid Signature" } }), { status: 401 })) as unknown as typeof fetch;
    const storage = new CloudinaryStorage({ cloudName: "x", apiKey: "k", apiSecret: "super-secret" }, fakeFetch);
    const error = await storage.put("resumes/a.pdf", Buffer.from("x"), "application/pdf").catch((e: Error) => e);
    expect((error as Error).message).toBe("Cloudinary upload failed (401): Invalid Signature");
    expect((error as Error).message).not.toContain("super-secret");
  });
});

describe("config: cloudinary", () => {
  const base = { NODE_ENV: "production", PUBLIC_SITE_URL: "https://rnk.example", MONGODB_URI: "mongodb://x", CONTACT_DESTINATION: "c@x.com", MAIL_TRANSPORT: "brevo", BREVO_API_KEY: "xkeysib-x", MAIL_FROM_EMAIL: "w@x.com", NEWSLETTER_LIST_IDS: '{"business":3,"disputes":4,"tax":5,"property":6,"ip":7,"people":8,"regulated":9}', DOI_TEMPLATE_ID: "2", MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };

  it("reads CLOUDINARY_URL and is allowed in production", () => {
    const config = loadConfig({ ...base, STORAGE_DRIVER: "cloudinary", CLOUDINARY_URL: "cloudinary://123456789:abc-DEF_ghi@rnk-legalheads" });
    expect(config.storage.driver).toBe("cloudinary");
    expect(config.storage.cloudinary).toEqual({ apiKey: "123456789", apiSecret: "abc-DEF_ghi", cloudName: "rnk-legalheads" });
  });

  it("explains a missing or malformed CLOUDINARY_URL", () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "cloudinary" })).toThrow(/CLOUDINARY_URL is required/);
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "cloudinary", CLOUDINARY_URL: "https://wrong" })).toThrow(/cloudinary:\/\//);
  });
});
