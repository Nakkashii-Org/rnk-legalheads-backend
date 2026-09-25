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
