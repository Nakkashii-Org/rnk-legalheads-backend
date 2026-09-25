import { CONTACT_SERVICE_OPTIONS } from "../data/services.js";
import { LINE_BREAK, SLUG_PATTERN, bool, clean, emailError, str, type FieldErrors } from "./common.js";

/**
 * Same rules and messages as the frontend's lib/contact-form.ts (guide p.136). Keep the two in
 * sync; the server is the one that counts.
 */
export const MESSAGE_MIN = 20;
export const MESSAGE_MAX = 1500;

export type ContactInput = {
  name: string;
  email: string;
  phone: string;
  organisation: string;
  service: string;
  message: string;
  acknowledged: boolean;
  context?: { kind: "person" | "industry"; slug: string };
  website: string;
};

export function parseContact(body: unknown): ContactInput {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const ctx = b.context && typeof b.context === "object" ? (b.context as Record<string, unknown>) : undefined;
  const kind = str(ctx?.kind);
  const slug = str(ctx?.slug);
  return {
    name: str(b.name).trim(),
    email: str(b.email).trim(),
    phone: str(b.phone).trim(),
    organisation: str(b.organisation).trim(),
    service: str(b.service),
    message: str(b.message).trim(),
    acknowledged: bool(b.acknowledged),
    // Context is only a label for routing; unknown kinds or malformed slugs are dropped, not rejected.
    context: (kind === "person" || kind === "industry") && SLUG_PATTERN.test(slug) && slug.length <= 100 ? { kind, slug } : undefined,
    website: str(b.website),
  };
}

export function validateContact(input: ContactInput): FieldErrors {
  const { name, email, phone, organisation, service, message } = input;
  return clean({
    name:
      name.length < 2
        ? "Enter your name."
        : name.length > 100
          ? "Name must be 100 characters or fewer."
          : LINE_BREAK.test(name)
            ? "Name must be on one line."
            : undefined,
    email: emailError(email),
    phone: phone.length > 30 || LINE_BREAK.test(phone) ? "Enter a phone number of 30 characters or fewer." : undefined,
    organisation: organisation.length > 150 || LINE_BREAK.test(organisation) ? "Organisation must be 150 characters or fewer." : undefined,
    service: service in CONTACT_SERVICE_OPTIONS ? undefined : "Choose a service, General enquiry or Not sure.",
    message:
      message.length < MESSAGE_MIN
        ? `Describe the subject in at least ${MESSAGE_MIN} characters.`
        : message.length > MESSAGE_MAX
          ? `Keep the description to ${MESSAGE_MAX.toLocaleString("en-GB")} characters or fewer.`
          : undefined,
    acknowledged: input.acknowledged ? undefined : "Confirm that you have read the notice before sending.",
  });
}
