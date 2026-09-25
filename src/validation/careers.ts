import { LINE_BREAK, SLUG_PATTERN, bool, clean, emailError, str, type FieldErrors } from "./common.js";

/**
 * Same rules and messages as the frontend's lib/career-form.ts. Keep the two in sync; the server
 * is the one that counts.
 */
export const COVER_NOTE_MAX = 1500;
export const RESUME_MAX_BYTES = 5 * 1024 * 1024;

export const GENERAL_POSITIONS: Record<string, string> = {
  "general-application": "General application",
  associate: "Associate",
  intern: "Intern",
  "support-staff": "Support staff",
};

export const EXPERIENCE_OPTIONS: Record<string, string> = {
  fresher: "Fresher / Student",
  "0-2": "0–2 years",
  "2-5": "2–5 years",
  "5-10": "5–10 years",
  "10-plus": "10+ years",
};

const PHONE_PATTERN = /^(\d{10}|\+\d{8,15})$/;

export type ApplicationInput = {
  name: string;
  email: string;
  phone: string;
  city: string;
  position: string;
  experience: string;
  qualification: string;
  barEnrolment: string;
  organisation: string;
  linkedin: string;
  coverNote: string;
  consent: boolean;
  website: string;
};

export function parseApplication(body: unknown): ApplicationInput {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const t = (k: string) => str(b[k]).trim();
  return {
    name: t("name"),
    email: t("email"),
    phone: t("phone"),
    city: t("city"),
    position: t("position"),
    experience: t("experience"),
    qualification: t("qualification"),
    barEnrolment: t("barEnrolment"),
    organisation: t("organisation"),
    linkedin: t("linkedin"),
    coverNote: t("coverNote"),
    consent: bool(b.consent),
    website: str(b.website),
  };
}

function singleLine(value: string, max: number, label: string, required: boolean): string | undefined {
  const cap = `${label[0]!.toUpperCase()}${label.slice(1)}`;
  if (required && !value) return `Enter your ${label}.`;
  if (value.length > max) return `${cap} must be ${max} characters or fewer.`;
  if (LINE_BREAK.test(value)) return `${cap} must be on one line.`;
  return undefined;
}

/**
 * A position is one of the general options or a vacancy slug. Vacancies are checked against open
 * jobs once they come from the CMS; until then the slug format is enforced.
 */
export const isAllowedPosition = (position: string) =>
  position in GENERAL_POSITIONS || (SLUG_PATTERN.test(position) && position.length <= 100);

export function validateApplication(input: ApplicationInput): FieldErrors {
  const phone = input.phone.replace(/[\s()-]/g, "");
  let linkedin: string | undefined;
  if (input.linkedin) {
    let valid = false;
    try {
      const url = new URL(input.linkedin);
      valid = (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
    } catch {}
    if (!valid || input.linkedin.length > 300) linkedin = "Enter the full profile link, starting with https://";
  }
  return clean({
    name: input.name.length < 2 ? "Enter your full name." : singleLine(input.name, 100, "full name", true),
    email: emailError(input.email),
    phone: !phone ? "Enter your phone number." : PHONE_PATTERN.test(phone) ? undefined : "Enter a 10-digit mobile number, or + and the country code.",
    city: singleLine(input.city, 100, "current city", true),
    position: isAllowedPosition(input.position) ? undefined : "Choose the position you are applying for.",
    experience: input.experience in EXPERIENCE_OPTIONS ? undefined : "Choose your experience.",
    qualification: singleLine(input.qualification, 150, "highest qualification", true),
    barEnrolment: singleLine(input.barEnrolment, 50, "bar enrolment number", false),
    organisation: singleLine(input.organisation, 150, "current organisation", false),
    linkedin,
    coverNote:
      input.coverNote.length > COVER_NOTE_MAX
        ? `Keep the cover note to ${COVER_NOTE_MAX.toLocaleString("en-GB")} characters or fewer.`
        : undefined,
    consent: input.consent ? undefined : "Confirm that your details may be used for recruitment.",
  });
}

export type ResumeKind = { ext: ".pdf" | ".doc" | ".docx"; mimeType: string };

/**
 * Identifies the resume by its actual bytes, not the file name or the browser's content type,
 * and requires the name's extension to agree.
 */
export function detectResume(buffer: Buffer, fileName: string): ResumeKind | undefined {
  const name = fileName.toLowerCase();
  const starts = (bytes: number[]) => bytes.every((b, i) => buffer[i] === b);
  if (name.endsWith(".pdf") && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { ext: ".pdf", mimeType: "application/pdf" };
  if (name.endsWith(".doc") && starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { ext: ".doc", mimeType: "application/msword" };
  if (name.endsWith(".docx") && starts([0x50, 0x4b, 0x03, 0x04]) && buffer.includes("word/"))
    return { ext: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  return undefined;
}

export function resumeError(file: { buffer: Buffer; originalname: string; size: number } | undefined): string | undefined {
  if (!file) return "Upload your resume.";
  if (file.size === 0) return "The selected resume file is empty.";
  if (file.size > RESUME_MAX_BYTES) return "The resume must be 5 MB or smaller.";
  if (!detectResume(file.buffer, file.originalname)) return "The resume must be a PDF, DOC or DOCX file.";
  return undefined;
}
