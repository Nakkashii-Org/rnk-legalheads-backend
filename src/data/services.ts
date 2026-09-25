/**
 * Contact form service options, copied from the frontend (lib/content/services.ts). Keep in sync
 * until services come from the CMS. Held services are not offered (guide p.63).
 */
export const SERVICES: { slug: string; title: string; hold?: boolean }[] = [
  { slug: "corporate-commercial", title: "Corporate & Commercial" },
  { slug: "mergers-acquisitions", title: "Mergers & Acquisitions" },
  { slug: "private-equity-venture-capital-startups", title: "Private Equity, Venture Capital & Startups" },
  { slug: "banking-finance", title: "Banking & Finance" },
  { slug: "capital-markets-securities", title: "Capital Markets & Securities" },
  { slug: "investment-funds", title: "Investment Funds & Asset Management" },
  { slug: "competition-antitrust", title: "Competition & Antitrust" },
  { slug: "foreign-investment-exchange-control", title: "Foreign Investment & Exchange Control" },
  { slug: "civil-commercial-litigation", title: "Civil & Commercial Litigation" },
  { slug: "arbitration", title: "Arbitration" },
  { slug: "mediation-settlement", title: "Mediation & Settlement" },
  { slug: "criminal-defence", title: "Criminal Defence" },
  { slug: "white-collar-investigations", title: "White-Collar Crime & Investigations" },
  { slug: "sarfaesi-drt-debt-recovery", title: "SARFAESI, DRT & Debt Recovery" },
  { slug: "insolvency-restructuring", title: "Insolvency & Restructuring" },
  { slug: "litigation-strategy-portfolio", title: "Litigation Strategy & Portfolio Management" },
  { slug: "litigation-funding-advisory", title: "Litigation Funding Advisory", hold: true },
  { slug: "direct-international-tax", title: "Direct & International Tax" },
  { slug: "gst-indirect-tax", title: "GST & Indirect Tax" },
  { slug: "customs-international-trade", title: "Customs & International Trade" },
  { slug: "tax-litigation-investigations", title: "Tax Litigation & Investigations" },
  { slug: "real-estate-rera", title: "Real Estate & RERA" },
  { slug: "construction-infrastructure", title: "Construction & Infrastructure" },
  { slug: "energy-natural-resources", title: "Energy & Natural Resources" },
  { slug: "environment-climate", title: "Environment & Climate" },
  { slug: "intellectual-property", title: "Intellectual Property" },
  { slug: "ip-disputes-enforcement", title: "IP Disputes & Enforcement" },
  { slug: "technology-data-cybersecurity", title: "Technology, Data & Cybersecurity" },
  { slug: "media-entertainment-sports", title: "Media, Entertainment & Sports" },
  { slug: "employment-labour-posh", title: "Employment, Labour & POSH" },
  { slug: "family-matrimonial", title: "Family & Matrimonial" },
  { slug: "private-client-succession", title: "Private Client, Wills & Succession" },
  { slug: "consumer-product-liability", title: "Consumer Protection & Product Liability" },
  { slug: "regulatory-public-law", title: "Regulatory & Public Law" },
  { slug: "healthcare-life-sciences", title: "Healthcare, Pharmaceuticals & Life Sciences" },
  { slug: "insurance", title: "Insurance" },
  { slug: "transport-maritime-aviation", title: "Transport, Maritime & Aviation" },
  { slug: "education-trusts-nonprofits", title: "Education, Trusts & Non-profits" },
  { slug: "immigration-global-mobility", title: "Immigration & Global Mobility" },
  { slug: "government-contracts-procurement", title: "Government Contracts & Procurement" },
];

export const GENERAL_ENQUIRY = "general-enquiry";
export const NOT_SURE = "not-sure";

export const CONTACT_SERVICE_OPTIONS: Record<string, string> = {
  [GENERAL_ENQUIRY]: "General enquiry",
  [NOT_SURE]: "Not sure",
  ...Object.fromEntries(SERVICES.filter((s) => !s.hold).map((s) => [s.slug, s.title])),
};
