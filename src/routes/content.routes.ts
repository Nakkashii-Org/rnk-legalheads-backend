import { Router } from "express";
import { ContentController } from "../controllers/content.controller.js";
import { rateLimitPerIp } from "../middlewares/security.js";
import type { Deps } from "../types.js";

export function contentRoutes(deps: Deps) {
  const c = new ContentController(deps);
  // Generous limit: the website's server fetches a cached bundle; this only stops abuse.
  const limit = rateLimitPerIp(600);
  return Router()
    .get("/content/bundle", limit, c.bundle)
    .get("/content/site-settings", limit, c.siteSettings)
    .get("/content/services", limit, c.services)
    .get("/content/services/:slug", limit, c.service)
    .get("/content/industries", limit, c.list("industries"))
    .get("/content/industries/:slug", limit, c.one("industries"))
    .get("/content/people", limit, c.list("people"))
    .get("/content/people/:slug", limit, c.one("people"))
    .get("/content/jobs", limit, c.list("jobs"))
    .get("/content/jobs/:slug", limit, c.one("jobs"))
    .get("/content/publications", limit, c.publications)
    .get("/content/publications/:type/:slug", limit, c.publication)
    .get("/content/newsletters", limit, c.list("newsletters"))
    .get("/content/newsletters/:slug", limit, c.one("newsletters"))
    .get("/search", limit, c.search);
}
