import type { Request, Response } from "express";
import { SiteSettings } from "../models/content/SiteSettings.js";
import { audit } from "../services/auth.js";

type Rec = Record<string, any>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{7,20}$/;

/** Editable firm facts: field → [label, max length, required]. API keys and passwords never belong here. */
const FIELDS: Record<string, [string, number, boolean]> = {
  name: ["Brand name", 80, true],
  legalEntity: ["Legal entity", 160, true],
  established: ["Established year", 4, true],
  statement: ["Footer statement", 300, true],
  disclaimer: ["Footer disclaimer", 600, true],
  address: ["Office address", 400, true],
  phone: ["Telephone", 20, false],
  email: ["Enquiry email", 120, true],
  mapQuery: ["Map location", 200, false],
  grievanceContact: ["Grievance / privacy contact", 160, false],
};

const view = (s: Rec | null) => ({
  name: s?.name ?? "",
  legalEntity: s?.legalEntity ?? "",
  established: s?.established ? String(s.established) : "",
  statement: s?.statement ?? "",
  disclaimer: s?.disclaimer ?? "",
  address: s?.contact?.address ?? "",
  phone: s?.contact?.phone ?? "",
  email: s?.contact?.email ?? "",
  mapQuery: s?.contact?.mapQuery ?? "",
  grievanceContact: s?.grievanceContact ?? "",
  updatedAt: s?.updatedAt,
});

/** Site settings (C5): Administrators only. */
export class SettingsController {
  /** GET /api/admin/settings */
  get = async (_req: Request, res: Response) => {
    res.json({ settings: view(await SiteSettings.findOne({ key: "site" }).lean<Rec>()) });
  };

  /** PATCH /api/admin/settings { name, legalEntity, … } → every field checked; the audit log lists what changed. */
  update = async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Rec;
    const values: Record<string, string> = {};
    const errors: Record<string, string> = {};
    for (const [field, [label, max, required]] of Object.entries(FIELDS)) {
      const value = typeof body[field] === "string" ? body[field].trim() : "";
      values[field] = value;
      if (required && !value) errors[field] = `${label} is required.`;
      else if (value.length > max) errors[field] = `${label} must be ${max} characters or fewer.`;
    }
    const year = Number(values.established);
    if (!errors.established && !(/^\d{4}$/.test(values.established!) && year >= 1900 && year <= new Date().getFullYear()))
      errors.established = "Enter a four-digit year, not in the future.";
    if (!errors.email && !EMAIL.test(values.email!)) errors.email = "Enter a valid email address.";
    if (values.phone && !errors.phone && !PHONE.test(values.phone)) errors.phone = "Enter a telephone number with digits only (spaces, +, brackets and - allowed).";
    if (Object.keys(errors).length) return void res.status(422).json({ errors });

    const before = view(await SiteSettings.findOne({ key: "site" }).lean<Rec>());
    const changed = Object.keys(FIELDS).filter((f) => (before as Rec)[f] !== values[f]);
    await SiteSettings.updateOne(
      { key: "site" },
      {
        $set: {
          name: values.name,
          legalEntity: values.legalEntity,
          established: year,
          statement: values.statement,
          disclaimer: values.disclaimer,
          ...(values.grievanceContact && { grievanceContact: values.grievanceContact }),
          contact: { address: values.address, phone: values.phone || undefined, email: values.email, mapQuery: values.mapQuery || undefined },
        },
        // An emptied optional field is removed, not left with its old value.
        ...(!values.grievanceContact && { $unset: { grievanceContact: 1 } }),
      },
      { upsert: true },
    );
    await audit("settings.updated", { actorId: req.user!.id, actorEmail: req.user!.email, target: "settings", detail: changed.length ? `changed: ${changed.join(", ")}` : "no changes" });
    res.json({ settings: view(await SiteSettings.findOne({ key: "site" }).lean<Rec>()) });
  };
}
