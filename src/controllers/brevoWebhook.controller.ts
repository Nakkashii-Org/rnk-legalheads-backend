import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { logger } from "../lib/logger.js";
import { SubscriptionEvent } from "../models/SubscriptionEvent.js";
import type { Deps } from "../types.js";

/** Brevo's event names (marketing and transactional webhooks spell them differently) → our consent history. */
const EVENTS: Record<string, "unsubscribed" | "bounced" | "complained"> = {
  unsubscribe: "unsubscribed",
  unsubscribed: "unsubscribed",
  hardbounce: "bounced",
  spam: "complained",
  complaint: "complained",
};

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/**
 * POST /api/webhooks/brevo?token=… (phase D3). Brevo reports unsubscribes from campaign links,
 * hard bounces and spam complaints; each is added to the consent history. Brevo itself already
 * stops sending to these addresses. Unknown events are acknowledged and ignored.
 */
export class BrevoWebhookController {
  constructor(private readonly deps: Deps) {}

  receive = async (req: Request, res: Response) => {
    const secret = this.deps.config.brevoWebhookSecret;
    if (!secret) return void res.status(404).json({ error: "not_found" });
    const given = Buffer.from(typeof req.query.token === "string" ? req.query.token : "");
    const expected = Buffer.from(secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return void res.status(401).json({ error: "unauthorized" });

    const payloads = (Array.isArray(req.body) ? req.body : [req.body]).slice(0, 100) as Record<string, unknown>[];
    let recorded = 0;
    for (const p of payloads) {
      const event = typeof p?.event === "string" ? p.event.toLowerCase().replace(/[_\s-]/g, "") : "";
      const email = typeof p?.email === "string" ? p.email.trim().toLowerCase() : "";
      const action = EVENTS[event];
      if (!action || !EMAIL.test(email)) continue;
      await SubscriptionEvent.create({ email, action, source: "brevo" });
      recorded++;
    }
    if (recorded) logger.info("brevo.webhook", { recorded });
    res.json({ ok: true, recorded });
  };
}
