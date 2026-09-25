import type { Request, Response } from "express";
import { newReference, sha256 } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { Application } from "../models/Application.js";
import { applicationEmail } from "../services/templates.js";
import type { Deps } from "../types.js";
import { EXPERIENCE_OPTIONS, GENERAL_POSITIONS, detectResume, parseApplication, resumeError, validateApplication } from "../validation/careers.js";

/** Careers applications with a compulsory resume. */
export class CareersController {
  constructor(private readonly deps: Deps) {}

  /**
   * POST /api/careers (multipart/form-data; the receiveResume middleware has parsed it)
   * 201 { reference } · 422 { errors } · 429 rate limited · 503 storage or delivery failed
   */
  create = async (req: Request, res: Response) => {
    const { config, mail, storage } = this.deps;
    const input = parseApplication(req.body);
    if (input.website) return void res.status(201).json({ reference: newReference() });

    const errors = validateApplication(input);
    const fileProblem = resumeError(req.file);
    if (fileProblem) errors.resume = fileProblem;
    if (Object.keys(errors).length) return void res.status(422).json({ errors });

    const file = req.file!;
    const kind = detectResume(file.buffer, file.originalname)!;
    const reference = newReference();
    const now = new Date();
    const key = `resumes/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${reference}${kind.ext}`;
    // A safe display name: the applicant's name, never the uploaded path or unusual characters.
    const safeName = `${input.name.replace(/[^\p{L}\p{N} .-]/gu, "").trim().replace(/\s+/g, "_").slice(0, 60) || "resume"}_${reference}${kind.ext}`;

    try {
      await storage.put(key, file.buffer, kind.mimeType);
    } catch (error) {
      logger.error("careers.storage_failed", { reference, error: (error as Error).name });
      return void res.status(503).json({ error: "storage_failed" });
    }

    // The reference is fixed before upload so the stored file and the record share it
    // (32^8 possible references; a collision fails safely on the unique index).
    const { website: _honeypot, ...fields } = input;
    const application = await Application.create({
      reference,
      ...fields,
      barEnrolment: input.barEnrolment || undefined,
      organisation: input.organisation || undefined,
      linkedin: input.linkedin || undefined,
      coverNote: input.coverNote || undefined,
      resume: { key, originalName: file.originalname.slice(0, 200), mimeType: kind.mimeType, size: file.size, sha256: sha256(file.buffer) },
    });

    try {
      const { messageId } = await mail.sendEmail(
        applicationEmail({
          reference,
          to: config.mail.careersDestination,
          name: input.name,
          email: input.email,
          phone: input.phone,
          city: input.city,
          positionLabel: GENERAL_POSITIONS[input.position] ?? `Vacancy: ${input.position}`,
          experienceLabel: EXPERIENCE_OPTIONS[input.experience]!,
          qualification: input.qualification,
          barEnrolment: input.barEnrolment || undefined,
          organisation: input.organisation || undefined,
          linkedin: input.linkedin || undefined,
          coverNote: input.coverNote || undefined,
          resumeName: safeName,
          attachment: config.mail.attachResume ? { name: safeName, content: file.buffer } : undefined,
        }),
      );
      application.delivery = { status: "sent", messageId, attemptedAt: new Date() };
      await application.save();
      logger.info("careers.received", { reference, position: input.position });
      res.status(201).json({ reference });
    } catch (error) {
      application.delivery = { status: "failed", error: (error as { code?: string }).code ?? (error as Error).name, attemptedAt: new Date() };
      await application.save();
      logger.error("careers.delivery_failed", { reference, status: (error as { status?: number }).status });
      res.status(503).json({ error: "delivery_failed" });
    }
  };
}
