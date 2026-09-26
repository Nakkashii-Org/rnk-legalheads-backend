import { Router } from "express";
import { HealthController } from "../controllers/health.controller.js";
import { requireOrigin } from "../middlewares/security.js";
import type { Deps } from "../types.js";
import { careersRoutes } from "./careers.routes.js";
import { contentRoutes } from "./content.routes.js";
import { contactRoutes } from "./contact.routes.js";
import { newsletterRoutes } from "./newsletter.routes.js";

/** Every route under /api. Routes only map URLs to controllers; the logic lives in the controllers. */
export function apiRoutes(deps: Deps) {
  const router = Router();
  router.get("/health", new HealthController().check);
  // Read-only content for the website (GET only, so no origin check needed).
  router.use(contentRoutes(deps));
  router.use(requireOrigin(deps.config.allowedOrigins));
  router.use(contactRoutes(deps));
  router.use(careersRoutes(deps));
  router.use(newsletterRoutes(deps));
  return router;
}
