import { Router } from "express";
import { ContactController } from "../controllers/contact.controller.js";
import { rateLimitPerIp } from "../middlewares/security.js";
import type { Deps } from "../types.js";

export function contactRoutes(deps: Deps) {
  const controller = new ContactController(deps);
  return Router().post("/contact", rateLimitPerIp(5), controller.create);
}
