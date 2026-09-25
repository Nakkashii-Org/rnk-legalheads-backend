import type { Request, Response } from "express";
import { CONTACT_SERVICE_OPTIONS } from "../data/services.js";
import { createWithReference, newReference } from "../lib/ids.js";
import { logger, maskEmail } from "../lib/logger.js";
import { Enquiry } from "../models/Enquiry.js";
import { enquiryEmail } from "../services/templates.js";
import type { Deps } from "../types.js";
import { parseContact, validateContact } from "../validation/contact.js";

/** Contact form (guide p.136, p.158). */
export class ContactController {
  constructor(private readonly deps: Deps) {}

  /**
   * POST /api/contact
   * 201 { reference } · 422 { errors } · 429 rate limited · 503 delivery failed (enquiry kept)
   */
  create = async (req: Request, res: Response) => {
    const { config, mail } = this.deps;
    const input = parseContact(req.body);

    // Honeypot filled: answer like a success so bots learn nothing, but store and send nothing.
    if (input.website) return void res.status(201).json({ reference: newReference() });

    const errors = validateContact(input);
    if (Object.keys(errors).length) return void res.status(422).json({ errors });

    const enquiry = await createWithReference((reference) =>
      Enquiry.create({
        reference,
        name: input.name,
        email: input.email,
        phone: input.phone || undefined,
        organisation: input.organisation || undefined,
        service: input.service,
        message: input.message,
        context: input.context,
        acknowledged: true,
      }),
    );

    try {
      const { messageId } = await mail.sendEmail(
        enquiryEmail({
          reference: enquiry.reference,
          to: config.mail.contactDestination,
          name: input.name,
          email: input.email,
          phone: input.phone || undefined,
          organisation: input.organisation || undefined,
          serviceLabel: CONTACT_SERVICE_OPTIONS[input.service]!,
          context: input.context ? `${input.context.kind === "person" ? "Lawyer" : "Sector"}: ${input.context.slug}` : undefined,
          message: input.message,
        }),
      );
      enquiry.delivery = { status: "sent", messageId, attemptedAt: new Date() };
      await enquiry.save();
      logger.info("contact.received", { reference: enquiry.reference, service: input.service });
      res.status(201).json({ reference: enquiry.reference });
    } catch (error) {
      // The enquiry stays saved for the CMS inbox; the visitor is told honestly it was not delivered.
      enquiry.delivery = { status: "failed", error: (error as { code?: string }).code ?? (error as Error).name, attemptedAt: new Date() };
      await enquiry.save();
      logger.error("contact.delivery_failed", { reference: enquiry.reference, from: maskEmail(input.email), status: (error as { status?: number }).status });
      res.status(503).json({ error: "delivery_failed" });
    }
  };
}
