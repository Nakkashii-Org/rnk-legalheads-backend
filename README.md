# rnk-legalhead-backend

API server for the RNK Legalheads website. It receives the contact form, job applications with
resumes, and newsletter subscriptions. Node.js, TypeScript, Express 5, MongoDB (Mongoose) and
Brevo for email.

The website (`rnk-legalhead-frontend`) forwards every browser request to `/api/*` here through a
Next.js rewrite, so the forms keep calling their own origin.

## Folder structure (MVC)

```
src/
  server.ts                 starts the app: loads config, connects MongoDB, listens
  app.ts                    Express setup: security headers, JSON body, /api routes, errors
  config.ts                 environment variables, checked at startup
  types.ts                  Deps: config, mail provider, storage (shared by controllers)
  routes/                   URL → controller mapping only, no logic
    index.ts                  /api router: health, origin check, then the route files
    contact.routes.ts         POST /contact
    careers.routes.ts         POST /careers
    newsletter.routes.ts      /subscribe, /subscribe/confirm, /preferences, /unsubscribe
  controllers/              request handling: read input, validate, call models/services, respond
    contact.controller.ts     ContactController.create
    careers.controller.ts     CareersController.create
    newsletter.controller.ts  NewsletterController.subscribe / confirm / getPreferences / updatePreferences / unsubscribe
    health.controller.ts      HealthController.check
  models/                   Mongoose models (M): Enquiry, Application, SubscriberToken
  services/                 outside systems and email content
    mail.ts                   MailProvider interface, BrevoProvider, LogProvider (dev)
    storage.ts                FileStorage interface, CloudinaryStorage, S3Storage (R2/S3), LocalStorage (dev)
    templates.ts              enquiry and application notification emails
  middlewares/              security.ts (origin check, rate limit), upload.ts (resume), error.ts
  validation/               field rules shared in spirit with the frontend forms
  data/services.ts          allowed service options for the contact form
  lib/                      ids (references, tokens, hashes), logger
```

A request flows: `routes/*.routes.ts` → middleware (origin, rate limit, upload) → `controllers/*.controller.ts` → `validation/`, `models/`, `services/` → JSON response (the "view").

## Endpoints (plan section 3.1)

| Method and path | Used by | Result |
|---|---|---|
| `POST /api/contact` | `/contact` form | `201 {reference}` · `422 {errors}` · `429` · `503` email failed (enquiry kept) |
| `POST /api/careers` (multipart, field `resume`) | `/careers`, `/careers/{slug}` | `201 {reference}` · `422 {errors}` · `415` · `429` · `503` |
| `POST /api/subscribe` | `/subscribe` | `202 {status:"pending"}` (neutral) · `422` · `429` · `503` |
| `GET /api/subscribe/confirm?token=` | `/subscribe/confirm` page (server-side) | `200 {status:"confirmed", manageToken}` · `409` not confirmed in Brevo · `410` expired |
| `GET /api/preferences?token=` | `/preferences` page (server-side) | `200 {topics}` · `410` |
| `POST /api/preferences` `{token, topics}` | Preferences form | `200 {topics}` · `422` · `410` |
| `POST /api/unsubscribe` `{token}` | Unsubscribe button | `200 {status:"unsubscribed"}` · `410` |
| `GET /api/health` | Render health check | `200 {status:"ok"}` or `503` |

Every `POST` must come from the website's origin (`403` otherwise). JSON bodies are limited to 16 KB,
resumes to 5 MB. Errors never include stack traces or provider details.

## How each form works

**Contact:** validate (same rules and messages as the frontend) → honeypot → save the enquiry →
Brevo emails `CONTACT_DESTINATION` with Reply-To set to the visitor → `201` with the reference. If
Brevo fails, the enquiry stays saved with `delivery.status = "failed"` and the visitor gets `503`.

**Careers:** the resume is checked by its actual bytes (PDF, DOC, DOCX) and size, stored in private
storage (`resumes/YYYY/MM/<reference>.<ext>`), the application is saved with the storage name, the
file's key and SHA-256, and Brevo emails `CAREERS_DESTINATION`, with the resume attached unless
`ATTACH_RESUME_TO_EMAIL=false`.

**Newsletter (double opt-in):**
1. `POST /api/subscribe` stores a hashed confirm token with the consent record (topics, notice
   version, time), then asks Brevo to send its double opt-in email. Brevo's redirect after the click
   is `PUBLIC_SITE_URL/subscribe/confirm?token=…`.
2. That page calls `GET /api/subscribe/confirm`, which checks with Brevo that the contact really is
   on the lists. It then issues a long-lived manage token, stores its hash, and writes the raw value
   to the Brevo contact attribute `MANAGE_TOKEN`.
3. Newsletter templates in Brevo link to
   `…/preferences?token={{ contact.MANAGE_TOKEN }}` and `…/unsubscribe?token={{ contact.MANAGE_TOKEN }}`.
4. Unsubscribe removes the contact from every topic list in Brevo, the source of truth.

### How long each link stays valid

| Link | Where the person gets it | Valid for | After that |
|---|---|---|---|
| **Confirm subscription** (Brevo's button) | Brevo's double opt-in email | Set by Brevo | Brevo shows its own expiry message |
| **`/subscribe/confirm?token=…`** (where Brevo sends them back) | Brevo redirects after the click | **7 days** from subscribing. It can be reopened within that time; it does not add a second "confirmed" entry. | "This link has expired" page. The token record is deleted automatically by MongoDB. |
| **`/preferences?token=…` and `/unsubscribe?token=…`** | Every newsletter email (`{{ contact.MANAGE_TOKEN }}`) | **2 years** from the last confirmation | "This link has expired" page. Confirming again issues a new link and **the old one stops working immediately.** |
| **`/contact/received?ref=…`, `/careers/received?ref=…`** | After sending a form | No expiry (shows only the reference) | — |

Numbers are in `src/controllers/newsletter.controller.ts` (`CONFIRM_TTL`, `MANAGE_TTL`).

### Consent history (MongoDB `subscriptionevents`)

Every step is recorded permanently, append-only:

| `action` | When | `topics` |
|---|---|---|
| `subscribe_requested` | Form sent; also stores `noticeVersion` | Topics ticked |
| `confirmed` | First time the confirmation link is opened | Topics Brevo confirmed |
| `preferences_updated` | Preferences saved | New topics |
| `unsubscribed` | Unsubscribe clicked | `[]` |

Brevo remains the source of truth for **current** topics; this collection is the audit trail of what
each person agreed to and when. It survives after the 7-day confirm token is deleted.

Only token hashes are stored. Email addresses never appear in URLs. Logs mask addresses and never
include message bodies, resumes or tokens.

## Brevo setup (once)

1. Verify the sending domain `rnklegalheads.com` (Brevo code, DKIM, SPF and DMARC DNS records).
2. Create an API key → `BREVO_API_KEY`.
3. Create 7 lists (Business, Disputes, Tax, Property, IP, People, Regulated) → `NEWSLETTER_LIST_IDS`.
4. Create a double opt-in confirmation template → `DOI_TEMPLATE_ID`.
5. Create the contact attribute `MANAGE_TOKEN` (text).

## Website content (phase A)

The website's content (services, industries, people, jobs, publications, newsletters and site
settings) lives in MongoDB and is served read-only:

| Endpoint | Returns |
|---|---|
| `GET /api/content/bundle` | Everything the website needs in one response (the website fetches this and caches it for 5 minutes) |
| `GET /api/content/site-settings` | Firm name, statement, disclaimer, contact details |
| `GET /api/content/services`, `/services/{slug}` | Services; the detail includes overview, scope and related services |
| `GET /api/content/industries`, `/people`, `/jobs`, `/newsletters` (and `/{slug}`) | Lists and single records |
| `GET /api/content/publications?type=&service=&year=&court=&q=&page=` | Filtered, 12 per page: `{ items, total, page, pageCount }` |
| `GET /api/content/publications/{type}/{slug}` | One article, judgment note or legal update |
| `GET /api/search?q=` | Matching services, people, publications and newsletter issues |

**Who sees what:**
- **Public:** only records with status `published`. Never layout previews or held services.
- **Draft review mode:** the website's server sends the header `x-content-preview: <CONTENT_PREVIEW_SECRET>`, and then drafts are included. Those responses are never cached.

**Import the content (once per database):**

```bash
npm run seed            # adds missing records from seed/content.json; never overwrites existing ones
npm run seed -- --force # overwrite existing records with the file's version
```

To import into Atlas from your computer, point `MONGODB_URI` at Atlas for that one command.
`seed/content.json` is exported from the website with:
`SHOW_DRAFT_CONTENT=true npx tsx scripts/export-content.ts ../rnk-legalhead-backend/seed/content.json`.
Everything is imported as a draft (guide p.150: approve record by record).

## Resume storage

| `STORAGE_DRIVER` | Where resumes go | Use |
|---|---|---|
| `cloudinary` | Cloudinary, as private **raw** files with delivery type **authenticated**. Nobody can open them from a public link. | **Current choice** (free plan, no card needed). Set `CLOUDINARY_URL`. |
| `s3` | Cloudflare R2 or AWS S3 private bucket | Later, if preferred. Set the `S3_*` values. |
| `local` | `.data/uploads` on this computer | Development only; refused in production |

**Cloudinary setup:** Cloudinary Dashboard → **API Keys** → copy the **API environment variable**
(`cloudinary://<api_key>:<api_secret>@<cloud_name>`) into `CLOUDINARY_URL`, and set
`STORAGE_DRIVER=cloudinary`. Uploaded resumes appear in **Media Library** under
`resumes/YYYY/MM/`. Each application records `resume.storage` and `resume.key` (the Cloudinary public id).

## Local development

```bash
npm install
cp .env.example .env        # MAIL_TRANSPORT=log and STORAGE_DRIVER=local need no accounts
npm run dev                 # needs a MongoDB at MONGODB_URI
```

In the frontend, set `BACKEND_URL=http://localhost:4000` and restart `next dev`.

With `MAIL_TRANSPORT=log`, emails are printed to the console. Double opt-in confirms immediately,
and the confirm link is printed, so the whole newsletter flow can be tried locally.

## Tests

```bash
npm test          # 52 tests; starts a throwaway in-memory MongoDB (first run downloads it)
npm run typecheck
```

## Deploy on Render

- **Web service:** build `npm ci --include=dev && npm run build` (with `NODE_ENV=production`, a plain
  `npm ci` skips TypeScript), start `npm start`, health check path `/api/health`. Do not set `PORT`.
- **Environment:** `NODE_ENV=production`, `MONGODB_URI` (MongoDB Atlas), `PUBLIC_SITE_URL`,
  `TRUST_PROXY`, the Brevo values, `STORAGE_DRIVER=cloudinary` and `CLOUDINARY_URL`. Production
  refuses `MAIL_TRANSPORT=log` and `STORAGE_DRIVER=local`, and prints any missing variable at startup.
- **Frontend service:** set `BACKEND_URL` to this service's URL **before building**. The rewrite is
  fixed at build time.
