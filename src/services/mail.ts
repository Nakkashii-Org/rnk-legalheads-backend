import type { Config } from "../config.js";
import { logger } from "../lib/logger.js";

export type Address = { email: string; name?: string };

export type EmailMessage = {
  to: Address[];
  replyTo?: Address;
  subject: string;
  text: string;
  html: string;
  attachments?: { name: string; content: Buffer }[];
  tags?: string[];
};

export type ContactState = { listIds: number[]; blacklisted: boolean };

/** Everything the backend needs from the email provider. Brevo in production. */
export interface MailProvider {
  sendEmail(message: EmailMessage): Promise<{ messageId?: string }>;
  /** Starts the provider's double opt-in: it emails a confirmation link and adds the contact only after the click. */
  startDoubleOptIn(input: { email: string; listIds: number[]; redirectionUrl: string; attributes?: Record<string, string> }): Promise<void>;
  /** undefined when the provider has no such contact. */
  getContact(email: string): Promise<ContactState | undefined>;
  updateContact(email: string, update: { linkListIds?: number[]; unlinkListIds?: number[]; attributes?: Record<string, string> }): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const BREVO = "https://api.brevo.com/v3";

/**
 * Brevo REST API v3. Endpoint names and fields follow Brevo's API reference; only allowlisted
 * values from our own validation are ever sent (guide p.158).
 */
export class BrevoProvider implements MailProvider {
  constructor(
    private readonly cfg: Config["mail"] & { doiTemplateId: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${BREVO}${path}`, {
        method,
        headers: { "api-key": this.cfg.brevoApiKey, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ProviderError(`Brevo request failed: ${(error as Error).name}`);
    }
    return response;
  }

  private async fail(response: Response, action: string): Promise<never> {
    const data = (await response.json().catch(() => ({}))) as { code?: string };
    throw new ProviderError(`Brevo ${action} failed`, response.status, data.code);
  }

  async sendEmail(message: EmailMessage) {
    const response = await this.call("POST", "/smtp/email", {
      sender: { email: this.cfg.fromEmail, name: this.cfg.fromName },
      to: message.to,
      replyTo: message.replyTo,
      subject: message.subject,
      textContent: message.text,
      htmlContent: message.html,
      attachment: message.attachments?.map((a) => ({ name: a.name, content: a.content.toString("base64") })),
      tags: message.tags,
    });
    if (!response.ok) await this.fail(response, "send email");
    const data = (await response.json().catch(() => ({}))) as { messageId?: string };
    return { messageId: data.messageId };
  }

  async startDoubleOptIn(input: { email: string; listIds: number[]; redirectionUrl: string; attributes?: Record<string, string> }) {
    const response = await this.call("POST", "/contacts/doubleOptinConfirmation", {
      email: input.email,
      includeListIds: input.listIds,
      templateId: this.cfg.doiTemplateId,
      redirectionUrl: input.redirectionUrl,
      attributes: input.attributes,
    });
    if (!response.ok) await this.fail(response, "double opt-in");
  }

  async getContact(email: string) {
    const response = await this.call("GET", `/contacts/${encodeURIComponent(email)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) await this.fail(response, "get contact");
    const data = (await response.json()) as { listIds?: number[]; emailBlacklisted?: boolean };
    return { listIds: data.listIds ?? [], blacklisted: Boolean(data.emailBlacklisted) };
  }

  async updateContact(email: string, update: { linkListIds?: number[]; unlinkListIds?: number[]; attributes?: Record<string, string> }) {
    const response = await this.call("PUT", `/contacts/${encodeURIComponent(email)}`, {
      listIds: update.linkListIds?.length ? update.linkListIds : undefined,
      unlinkListIds: update.unlinkListIds?.length ? update.unlinkListIds : undefined,
      attributes: update.attributes,
    });
    if (!response.ok) await this.fail(response, "update contact");
  }
}

/**
 * Development only (refused in production by the config). Prints what would be sent and keeps
 * contacts in memory, confirming them immediately, so every flow can be tried without Brevo.
 */
export class LogProvider implements MailProvider {
  readonly sent: EmailMessage[] = [];
  readonly contacts = new Map<string, ContactState>();
  readonly optIns: { email: string; listIds: number[]; redirectionUrl: string }[] = [];

  async sendEmail(message: EmailMessage) {
    this.sent.push(message);
    logger.info("mail.log", {
      to: message.to.map((t) => t.email).join(", "),
      subject: message.subject,
      attachments: message.attachments?.map((a) => `${a.name} (${a.content.length} bytes)`).join(", "),
    });
    return { messageId: `log-${this.sent.length}` };
  }

  async startDoubleOptIn(input: { email: string; listIds: number[]; redirectionUrl: string }) {
    this.optIns.push(input);
    // Simulates the subscriber clicking the confirmation link straight away.
    this.contacts.set(input.email, { listIds: [...input.listIds], blacklisted: false });
    logger.info("mail.log.double_opt_in", { confirmLink: input.redirectionUrl });
  }

  async getContact(email: string) {
    return this.contacts.get(email);
  }

  async updateContact(email: string, update: { linkListIds?: number[]; unlinkListIds?: number[] }) {
    const contact = this.contacts.get(email);
    if (!contact) throw new ProviderError("Contact not found", 404);
    const lists = new Set(contact.listIds);
    update.linkListIds?.forEach((id) => lists.add(id));
    update.unlinkListIds?.forEach((id) => lists.delete(id));
    contact.listIds = [...lists];
  }
}

export function createMailProvider(config: Config): MailProvider {
  return config.mail.transport === "brevo"
    ? new BrevoProvider({ ...config.mail, doiTemplateId: config.newsletter.doiTemplateId })
    : new LogProvider();
}
