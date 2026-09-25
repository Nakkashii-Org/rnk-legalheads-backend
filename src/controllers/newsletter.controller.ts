import type { Request, Response } from "express";
import { NEWSLETTER_TOPIC_IDS } from "../config.js";
import { newToken, sha256 } from "../lib/ids.js";
import { logger, maskEmail } from "../lib/logger.js";
import { SubscriberToken } from "../models/SubscriberToken.js";
import { SubscriptionEvent } from "../models/SubscriptionEvent.js";
import type { ProviderError } from "../services/mail.js";
import type { Deps } from "../types.js";
import { isTopic, parseSubscribe, parseTopics, readToken, validateSubscribe } from "../validation/newsletter.js";

const DAY = 24 * 60 * 60 * 1000;
const CONFIRM_TTL = 7 * DAY;
const MANAGE_TTL = 730 * DAY;

const providerStatus = (error: unknown) => (error as ProviderError).status;

type EventInput = { email: string; action: "subscribe_requested" | "confirmed" | "preferences_updated" | "unsubscribed"; topics?: string[]; noticeVersion?: string };

/**
 * Writes the consent history. The action has already happened in Brevo, so a failed log write is
 * reported in the server log but does not turn a completed action into an error for the visitor.
 */
async function recordEvent(event: EventInput) {
  try {
    await SubscriptionEvent.create(event);
  } catch (error) {
    logger.error("newsletter.event_log_failed", { action: event.action, error: (error as Error).name });
  }
}

/**
 * Newsletter double opt-in and preferences (guide p.127–133, p.158). Brevo holds subscription
 * state; we keep hashed link tokens, the consent record and a history of every change
 * (SubscriptionEvent).
 */
export class NewsletterController {
  constructor(private readonly deps: Deps) {}

  private listFor = (topic: string) => this.deps.config.newsletter.listIds[topic]!;
  private allLists = () => NEWSLETTER_TOPIC_IDS.map(this.listFor);
  private topicsOf = (listIds: number[]) => NEWSLETTER_TOPIC_IDS.filter((t) => listIds.includes(this.listFor(t)));

  private async findToken(raw: string | undefined, purpose: "confirm" | "manage") {
    if (!raw) return undefined;
    const doc = await SubscriberToken.findOne({ hash: sha256(raw), purpose });
    return doc && doc.expiresAt > new Date() ? doc : undefined;
  }

  /** POST /api/subscribe → 202 pending, whatever the address's current state (neutral, p.130). */
  subscribe = async (req: Request, res: Response) => {
    const input = parseSubscribe(req.body);
    if (input.website) return void res.status(202).json({ status: "pending" });

    const errors = validateSubscribe(input);
    if (Object.keys(errors).length) return void res.status(422).json({ errors });

    const raw = newToken();
    const token = await SubscriberToken.create({
      hash: sha256(raw),
      purpose: "confirm",
      email: input.email,
      topics: input.topics,
      noticeVersion: input.noticeVersion || undefined,
      consentAt: new Date(),
      expiresAt: new Date(Date.now() + CONFIRM_TTL),
    });

    try {
      await this.deps.mail.startDoubleOptIn({
        email: input.email,
        listIds: input.topics.map(this.listFor),
        redirectionUrl: `${this.deps.config.publicSiteUrl}/subscribe/confirm?token=${raw}`,
      });
      await recordEvent({ email: input.email, action: "subscribe_requested", topics: input.topics, noticeVersion: input.noticeVersion || undefined });
      logger.info("newsletter.pending", { email: maskEmail(input.email), topics: input.topics.join(",") });
      res.status(202).json({ status: "pending" });
    } catch (error) {
      await token.deleteOne();
      logger.error("newsletter.doi_failed", { status: providerStatus(error), code: (error as ProviderError).code });
      res.status(503).json({ error: "provider_unavailable" });
    }
  };

  /**
   * GET /api/subscribe/confirm?token= (called by the frontend's /subscribe/confirm page after
   * Brevo redirects the subscriber). Checks Brevo's real state; the link alone proves nothing.
   */
  confirm = async (req: Request, res: Response) => {
    const token = await this.findToken(readToken(req.query.token), "confirm");
    if (!token) return void res.status(410).json({ status: "expired" });

    try {
      const contact = await this.deps.mail.getContact(token.email);
      const wanted = (token.topics ?? []).map(this.listFor);
      if (!contact || contact.blacklisted || !wanted.some((id) => contact.listIds.includes(id)))
        return void res.status(409).json({ status: "unconfirmed" });

      // Issue a fresh link for /preferences and /unsubscribe. Its raw value goes into the Brevo
      // contact attribute MANAGE_TOKEN so newsletter templates can build personal links.
      const manage = newToken();
      await SubscriberToken.deleteMany({ email: token.email, purpose: "manage" });
      await SubscriberToken.create({ hash: sha256(manage), purpose: "manage", email: token.email, expiresAt: new Date(Date.now() + MANAGE_TTL) });
      await this.deps.mail.updateContact(token.email, { attributes: { MANAGE_TOKEN: manage } }).catch((error: ProviderError) => {
        logger.warn("newsletter.manage_attribute_failed", { status: error.status, code: error.code });
      });
      if (!token.confirmedAt) {
        token.confirmedAt = new Date();
        await token.save();
        await recordEvent({ email: token.email, action: "confirmed", topics: this.topicsOf(contact.listIds) });
        logger.info("newsletter.confirmed", { email: maskEmail(token.email) });
      }
      res.json({ status: "confirmed", manageToken: manage });
    } catch (error) {
      logger.error("newsletter.confirm_failed", { status: providerStatus(error) });
      res.status(503).json({ error: "provider_unavailable" });
    }
  };

  /** GET /api/preferences?token= → the subscriber's current topics. No public lookup by email. */
  getPreferences = async (req: Request, res: Response) => {
    const token = await this.findToken(readToken(req.query.token), "manage");
    if (!token) return void res.status(410).json({ status: "expired" });
    try {
      const contact = await this.deps.mail.getContact(token.email);
      if (!contact) return void res.status(410).json({ status: "expired" });
      res.json({ topics: contact.blacklisted ? [] : this.topicsOf(contact.listIds) });
    } catch (error) {
      logger.error("newsletter.preferences_read_failed", { status: providerStatus(error) });
      res.status(503).json({ error: "provider_unavailable" });
    }
  };

  /** POST /api/preferences { token, topics } → saved topics. */
  updatePreferences = async (req: Request, res: Response) => {
    const token = await this.findToken(readToken((req.body as { token?: unknown } | undefined)?.token), "manage");
    if (!token) return void res.status(410).json({ status: "expired" });

    const topics = parseTopics(req.body);
    if (topics.length === 0 || topics.some((t) => !isTopic(t)))
      return void res
        .status(422)
        .json({ errors: { topics: topics.length ? "Choose topics from the list." : "Choose at least one topic, or unsubscribe from all updates." } });

    try {
      const keep = topics.map(this.listFor);
      await this.deps.mail.updateContact(token.email, { linkListIds: keep, unlinkListIds: this.allLists().filter((id) => !keep.includes(id)) });
      await recordEvent({ email: token.email, action: "preferences_updated", topics });
      logger.info("newsletter.preferences_saved", { email: maskEmail(token.email), topics: topics.join(",") });
      res.json({ topics });
    } catch (error) {
      if (providerStatus(error) === 404) return void res.status(410).json({ status: "expired" });
      logger.error("newsletter.preferences_failed", { status: providerStatus(error) });
      res.status(503).json({ error: "provider_unavailable" });
    }
  };

  /** POST /api/unsubscribe { token } → removed from every newsletter list in Brevo. */
  unsubscribe = async (req: Request, res: Response) => {
    const token = await this.findToken(readToken((req.body as { token?: unknown } | undefined)?.token), "manage");
    if (!token) return void res.status(410).json({ status: "expired" });
    try {
      await this.deps.mail.updateContact(token.email, { unlinkListIds: this.allLists() });
      await recordEvent({ email: token.email, action: "unsubscribed", topics: [] });
      logger.info("newsletter.unsubscribed", { email: maskEmail(token.email) });
      res.json({ status: "unsubscribed" });
    } catch (error) {
      // A contact Brevo no longer holds is already not receiving newsletters.
      if (providerStatus(error) === 404) {
        await recordEvent({ email: token.email, action: "unsubscribed", topics: [] });
        return void res.json({ status: "unsubscribed" });
      }
      logger.error("newsletter.unsubscribe_failed", { status: providerStatus(error) });
      res.status(503).json({ error: "provider_unavailable" });
    }
  };
}
