import type { EmailMessage } from "./mail.js";

/** Internal notification emails to the firm. All visitor text is escaped before it goes into HTML. */

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

type Row = [label: string, value: string | undefined];

function render(title: string, intro: string, rows: Row[], longText?: [label: string, value: string]) {
  const shown = rows.filter((r): r is [string, string] => Boolean(r[1]));
  const text = [
    title,
    "",
    intro,
    "",
    ...shown.map(([l, v]) => `${l}: ${v}`),
    ...(longText ? ["", `${longText[0]}:`, longText[1]] : []),
    "",
    "Sent automatically by the RNK Legalheads website.",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f6f3;font-family:Arial,Helvetica,sans-serif;color:#1e1e1e">
<table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #ddd9d4">
<tr><td style="padding:24px 28px;border-top:4px solid #ec3e3f">
<h1 style="margin:0 0 8px;font-family:Georgia,serif;font-size:22px;font-weight:normal">${escape(title)}</h1>
<p style="margin:0 0 20px;color:#605f5c;font-size:14px">${escape(intro)}</p>
<table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">
${shown.map(([l, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#605f5c;vertical-align:top;white-space:nowrap">${escape(l)}</td><td style="padding:6px 0">${escape(v)}</td></tr>`).join("\n")}
</table>
${longText ? `<h2 style="margin:20px 0 6px;font-size:14px">${escape(longText[0])}</h2><p style="margin:0;font-size:14px;line-height:22px;white-space:pre-wrap">${escape(longText[1])}</p>` : ""}
<p style="margin:24px 0 0;color:#605f5c;font-size:12px">Sent automatically by the RNK Legalheads website.</p>
</td></tr></table></body></html>`;
  return { text, html };
}

export function enquiryEmail(input: {
  reference: string;
  to: string;
  name: string;
  email: string;
  phone?: string;
  organisation?: string;
  serviceLabel: string;
  context?: string;
  message: string;
}): EmailMessage {
  const { text, html } = render(
    `New website enquiry ${input.reference}`,
    "Reply to this email to answer the sender directly. This is not yet an instruction; check conflicts before substantive work.",
    [
      ["Reference", input.reference],
      ["Service", input.serviceLabel],
      ["Context", input.context],
      ["Name", input.name],
      ["Email", input.email],
      ["Phone", input.phone],
      ["Organisation", input.organisation],
    ],
    ["Enquiry", input.message],
  );
  return {
    to: [{ email: input.to }],
    replyTo: { email: input.email, name: input.name },
    subject: `Website enquiry ${input.reference}: ${input.serviceLabel}`,
    text,
    html,
    tags: ["contact-enquiry"],
  };
}

export function applicationEmail(input: {
  reference: string;
  to: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  positionLabel: string;
  experienceLabel: string;
  qualification: string;
  barEnrolment?: string;
  organisation?: string;
  linkedin?: string;
  coverNote?: string;
  resumeName: string;
  attachment?: { name: string; content: Buffer };
}): EmailMessage {
  const { text, html } = render(
    `New job application ${input.reference}`,
    input.attachment
      ? "The resume is attached. Handle it as confidential recruitment data and delete copies when no longer needed."
      : "The resume is stored securely and will be available in the CMS Applications inbox.",
    [
      ["Reference", input.reference],
      ["Position", input.positionLabel],
      ["Name", input.name],
      ["Email", input.email],
      ["Phone", input.phone],
      ["City", input.city],
      ["Experience", input.experienceLabel],
      ["Qualification", input.qualification],
      ["Bar enrolment", input.barEnrolment],
      ["Current organisation", input.organisation],
      ["LinkedIn", input.linkedin],
      ["Resume", input.resumeName],
    ],
    input.coverNote ? ["Cover note", input.coverNote] : undefined,
  );
  return {
    to: [{ email: input.to }],
    replyTo: { email: input.email, name: input.name },
    subject: `Job application ${input.reference}: ${input.positionLabel}`,
    text,
    html,
    attachments: input.attachment ? [input.attachment] : undefined,
    tags: ["job-application"],
  };
}

const ROLE_LABELS: Record<string, string> = { contributor: "Contributor", reviewer: "Legal reviewer", publisher: "Publisher", admin: "Administrator" };

/** CMS invitation: a one-time link to set a password and 2-step verification (valid 72 hours). */
export function inviteEmail(input: { to: string; name: string; invitedBy: string; link: string; roles: string[] }): EmailMessage {
  const roles = input.roles.map((r) => ROLE_LABELS[r] ?? r).join(", ");
  const text = [
    `Hello ${input.name},`,
    "",
    `${input.invitedBy} has invited you to the RNK Legalheads website CMS as: ${roles}.`,
    "",
    "Set up your account (link valid for 72 hours, can be used once):",
    input.link,
    "",
    "You will choose a password and connect an authenticator app (Google or Microsoft Authenticator) for 2-step verification.",
    "If you weren't expecting this, you can ignore this email.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f6f3;font-family:Arial,Helvetica,sans-serif;color:#1e1e1e">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ddd9d4">
<tr><td style="padding:28px 32px;border-top:4px solid #ec3e3f">
<p style="margin:0 0 20px;font-weight:bold;font-size:18px">RNK Legalheads CMS</p>
<h1 style="margin:0 0 12px;font-family:Georgia,serif;font-size:22px;font-weight:normal">You've been invited</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:24px">Hello ${escape(input.name)},</p>
<p style="margin:0 0 20px;font-size:15px;line-height:24px;color:#605f5c">${escape(input.invitedBy)} has invited you to the website CMS as <strong style="color:#1e1e1e">${escape(roles)}</strong>.</p>
<a href="${escape(input.link)}" style="display:inline-block;background:#1e1e1e;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 24px">Set up my account</a>
<p style="margin:20px 0 0;font-size:13px;line-height:20px;color:#605f5c">The link works once and expires in 72 hours. You'll choose a password and connect an authenticator app (Google or Microsoft Authenticator) for 2-step verification. If you weren't expecting this, ignore this email.</p>
</td></tr></table></body></html>`;
  return { to: [{ email: input.to, name: input.name }], subject: "Your invitation to the RNK Legalheads CMS", text, html, tags: ["cms-invite"] };
}

/** Password reset link sent by an Administrator (valid 1 hour, works once). */
export function passwordResetEmail(input: { to: string; name: string; sentBy: string; link: string }): EmailMessage {
  const text = [
    `Hello ${input.name},`,
    "",
    `${input.sentBy} has sent you a link to choose a new password for the RNK Legalheads website CMS.`,
    "",
    "Choose a new password (link valid for 1 hour, can be used once):",
    input.link,
    "",
    "You'll also need a 6-digit code from your authenticator app.",
    "If you didn't ask for this, you can ignore this email: your current password keeps working.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f6f3;font-family:Arial,Helvetica,sans-serif;color:#1e1e1e">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ddd9d4">
<tr><td style="padding:28px 32px;border-top:4px solid #ec3e3f">
<p style="margin:0 0 20px;font-weight:bold;font-size:18px">RNK Legalheads CMS</p>
<h1 style="margin:0 0 12px;font-family:Georgia,serif;font-size:22px;font-weight:normal">Choose a new password</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:24px">Hello ${escape(input.name)},</p>
<p style="margin:0 0 20px;font-size:15px;line-height:24px;color:#605f5c">${escape(input.sentBy)} has sent you a link to choose a new password for the website CMS.</p>
<a href="${escape(input.link)}" style="display:inline-block;background:#1e1e1e;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 24px">Choose a new password</a>
<p style="margin:20px 0 0;font-size:13px;line-height:20px;color:#605f5c">The link works once and expires in 1 hour. You'll also need a 6-digit code from your authenticator app. If you didn't ask for this, ignore this email: your current password keeps working.</p>
</td></tr></table></body></html>`;
  return { to: [{ email: input.to, name: input.name }], subject: "Choose a new password for the RNK Legalheads CMS", text, html, tags: ["cms-invite", "cms-password-reset"] };
}

export const PUBLICATION_PATHS: Record<string, string> = { article: "/articles", judgment: "/recent-judgments", update: "/legal-updates" };

/**
 * A published newsletter issue as a Brevo campaign (phase D3). Brevo fills {{ contact.MANAGE_TOKEN }}
 * per subscriber (set when they confirmed) and {{ unsubscribe }} with its own one-click link.
 */
export function newsletterCampaignHtml(input: {
  siteUrl: string;
  siteName: string;
  issue: { title: string; slug: string; issueDate?: string; introduction?: string };
  items: { type: string; slug: string; title: string; summary?: string }[];
}): string {
  const issueUrl = `${input.siteUrl}/newsletters/${input.issue.slug}`;
  const date = input.issue.issueDate
    ? new Date(`${input.issue.issueDate}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : "";
  const items = input.items
    .map((i) => {
      const url = `${input.siteUrl}${PUBLICATION_PATHS[i.type] ?? ""}/${i.slug}`;
      return `<tr><td style="padding:16px 0;border-top:1px solid #ddd9d4">
<a href="${escape(url)}" style="font-family:Georgia,serif;font-size:19px;line-height:26px;color:#1e1e1e">${escape(i.title)}</a>
${i.summary ? `<p style="margin:6px 0 0;font-size:14px;line-height:22px;color:#605f5c">${escape(i.summary)}</p>` : ""}
</td></tr>`;
    })
    .join("\n");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f6f3;font-family:Arial,Helvetica,sans-serif;color:#1e1e1e">
<table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #ddd9d4">
<tr><td style="padding:28px 32px;border-top:4px solid #ec3e3f">
<p style="margin:0 0 20px;font-weight:bold;font-size:18px">${escape(input.siteName)}</p>
<h1 style="margin:0 0 6px;font-family:Georgia,serif;font-size:26px;font-weight:normal">${escape(input.issue.title)}</h1>
${date ? `<p style="margin:0 0 16px;font-size:13px;color:#605f5c">${escape(date)}</p>` : ""}
${input.issue.introduction ? `<p style="margin:0 0 16px;font-size:15px;line-height:24px">${escape(input.issue.introduction)}</p>` : ""}
<table role="presentation" width="100%">${items}</table>
<p style="margin:20px 0 0"><a href="${escape(issueUrl)}" style="color:#1e1e1e;font-weight:bold">Read this issue on our website</a></p>
<p style="margin:28px 0 0;font-size:12px;line-height:18px;color:#605f5c">This newsletter is for general information and is not legal advice.
<a href="${escape(input.siteUrl)}/preferences?token={{ contact.MANAGE_TOKEN }}" style="color:#605f5c">Choose your topics</a> ·
<a href="{{ unsubscribe }}" style="color:#605f5c">Unsubscribe</a></p>
</td></tr></table></body></html>`;
}
