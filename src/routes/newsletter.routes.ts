import { Router } from "express";
import { NewsletterController } from "../controllers/newsletter.controller.js";
import { rateLimitPerIp } from "../middlewares/security.js";
import type { Deps } from "../types.js";

export function newsletterRoutes(deps: Deps) {
  const controller = new NewsletterController(deps);
  return Router()
    .post("/subscribe", rateLimitPerIp(5), controller.subscribe)
    .get("/subscribe/confirm", rateLimitPerIp(30), controller.confirm)
    .get("/preferences", rateLimitPerIp(30), controller.getPreferences)
    .post("/preferences", rateLimitPerIp(30), controller.updatePreferences)
    .post("/unsubscribe", rateLimitPerIp(30), controller.unsubscribe);
}
