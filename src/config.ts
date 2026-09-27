/**
 * Environment configuration, validated once at startup (guide p.160). Secrets come only from the
 * environment; nothing here is ever sent to a browser.
 */

export type Config = {
  env: "development" | "test" | "production";
  port: number;
  mongoUri: string;
  publicSiteUrl: string;
  allowedOrigins: string[];
  trustProxy: number;
  /** Shared with the website's server so draft review mode can read drafts. Empty = drafts never served. */
  contentPreviewSecret: string;
  /** Shared secret in the Brevo webhook URL (?token=). Empty: the webhook is switched off. */
  brevoWebhookSecret: string;
  /** 32-byte key that encrypts 2-step verification secrets at rest. */
  mfaEncryptionKey: Buffer;
  mail: {
    transport: "brevo" | "log";
    brevoApiKey: string;
    fromEmail: string;
    fromName: string;
    contactDestination: string;
    careersDestination: string;
    attachResume: boolean;
  };
  newsletter: {
    /** Topic id (service group key) → Brevo list id. */
    listIds: Record<string, number>;
    doiTemplateId: number;
  };
  storage: {
    driver: "s3" | "cloudinary" | "local";
    localDir: string;
    s3: { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
    cloudinary: { cloudName: string; apiKey: string; apiSecret: string };
  };
};

export const NEWSLETTER_TOPIC_IDS = ["business", "disputes", "tax", "property", "ip", "people", "regulated"] as const;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const nodeEnv = (env.NODE_ENV ?? "development") as Config["env"];
  const production = nodeEnv === "production";

  const required = (name: string, fallback?: string) => {
    const value = env[name]?.trim() || fallback;
    if (!value) problems.push(`${name} is required`);
    return value ?? "";
  };
  const integer = (name: string, fallback?: number) => {
    const raw = env[name]?.trim();
    if (!raw) {
      if (fallback === undefined) problems.push(`${name} is required`);
      return fallback ?? 0;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) problems.push(`${name} must be a whole number`);
    return n;
  };

  const publicSiteUrl = required("PUBLIC_SITE_URL", production ? undefined : "http://localhost:3000").replace(/\/+$/, "");
  const transport = (env.MAIL_TRANSPORT?.trim() || (production ? "brevo" : "log")) as Config["mail"]["transport"];
  if (!["brevo", "log"].includes(transport)) problems.push("MAIL_TRANSPORT must be brevo or log");
  if (production && transport !== "brevo") problems.push("MAIL_TRANSPORT=log is not allowed in production");

  const driver = (env.STORAGE_DRIVER?.trim() || (production ? "s3" : "local")) as Config["storage"]["driver"];
  if (!["s3", "cloudinary", "local"].includes(driver)) problems.push("STORAGE_DRIVER must be s3, cloudinary or local");
  if (production && driver === "local") problems.push("STORAGE_DRIVER=local is not allowed in production");

  // Cloudinary's standard setting: cloudinary://<api_key>:<api_secret>@<cloud_name>
  let cloudinary = { cloudName: "", apiKey: "", apiSecret: "" };
  if (driver === "cloudinary") {
    const match = /^cloudinary:\/\/([^:@\s]+):([^@\s]+)@([^/\s?]+)\/?$/.exec(env.CLOUDINARY_URL?.trim() ?? "");
    if (match) cloudinary = { apiKey: match[1]!, apiSecret: match[2]!, cloudName: match[3]! };
    else problems.push("CLOUDINARY_URL is required, in the form cloudinary://<api_key>:<api_secret>@<cloud_name>");
  }

  let listIds: Record<string, number> = {};
  const rawLists = env.NEWSLETTER_LIST_IDS?.trim();
  if (rawLists) {
    try {
      listIds = JSON.parse(rawLists);
      for (const topic of NEWSLETTER_TOPIC_IDS)
        if (!Number.isInteger(listIds[topic])) problems.push(`NEWSLETTER_LIST_IDS is missing a list id for "${topic}"`);
    } catch {
      problems.push("NEWSLETTER_LIST_IDS must be JSON, e.g. {\"business\":3,\"disputes\":4,…}");
    }
  } else if (transport === "brevo") problems.push("NEWSLETTER_LIST_IDS is required");
  else listIds = Object.fromEntries(NEWSLETTER_TOPIC_IDS.map((t, i) => [t, i + 1]));

  const previewSecret = env.CONTENT_PREVIEW_SECRET?.trim() ?? "";
  if (previewSecret && previewSecret.length < 24) problems.push("CONTENT_PREVIEW_SECRET must be at least 24 characters (or left empty)");
  const webhookSecret = env.BREVO_WEBHOOK_SECRET?.trim() ?? "";
  if (webhookSecret && webhookSecret.length < 24) problems.push("BREVO_WEBHOOK_SECRET must be at least 24 characters (or left empty)");

  // MFA_ENCRYPTION_KEY: 32 random bytes, base64. Required in production; a fixed key is used in development and tests.
  let mfaEncryptionKey = Buffer.from("0123456789abcdef0123456789abcdef");
  const rawMfaKey = env.MFA_ENCRYPTION_KEY?.trim();
  if (rawMfaKey) {
    mfaEncryptionKey = Buffer.from(rawMfaKey, "base64");
    if (mfaEncryptionKey.length !== 32) problems.push("MFA_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  } else if (production) problems.push("MFA_ENCRYPTION_KEY is required");

  const brevo = transport === "brevo";
  const s3 = driver === "s3";
  const contactDestination = required("CONTACT_DESTINATION", production ? undefined : "contact@rnklegalheads.com");

  const config: Config = {
    env: nodeEnv,
    port: integer("PORT", 4000),
    mongoUri: required("MONGODB_URI", production ? undefined : "mongodb://127.0.0.1:27017/rnk-legalheads"),
    publicSiteUrl,
    allowedOrigins: (env.ALLOWED_ORIGINS?.trim() || publicSiteUrl)
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    trustProxy: integer("TRUST_PROXY", 1),
    contentPreviewSecret: previewSecret,
    brevoWebhookSecret: webhookSecret,
    mfaEncryptionKey,
    mail: {
      transport,
      brevoApiKey: brevo ? required("BREVO_API_KEY") : "",
      fromEmail: brevo ? required("MAIL_FROM_EMAIL") : env.MAIL_FROM_EMAIL?.trim() || "website@rnklegalheads.com",
      fromName: env.MAIL_FROM_NAME?.trim() || "RNK Legalheads website",
      contactDestination,
      careersDestination: env.CAREERS_DESTINATION?.trim() || contactDestination,
      attachResume: (env.ATTACH_RESUME_TO_EMAIL ?? "true").trim() !== "false",
    },
    newsletter: {
      listIds,
      doiTemplateId: brevo ? integer("DOI_TEMPLATE_ID") : integer("DOI_TEMPLATE_ID", 1),
    },
    storage: {
      driver,
      localDir: env.LOCAL_STORAGE_DIR?.trim() || ".data/uploads",
      s3: {
        endpoint: env.S3_ENDPOINT?.trim() || undefined,
        region: env.S3_REGION?.trim() || "auto",
        bucket: s3 ? required("S3_BUCKET") : "",
        accessKeyId: s3 ? required("S3_ACCESS_KEY_ID") : "",
        secretAccessKey: s3 ? required("S3_SECRET_ACCESS_KEY") : "",
      },
      cloudinary,
    },
  };

  if (problems.length) throw new ConfigError(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  return config;
}
