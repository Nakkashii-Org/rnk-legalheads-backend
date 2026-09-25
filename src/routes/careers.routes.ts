import { Router } from "express";
import { CareersController } from "../controllers/careers.controller.js";
import { rateLimitPerIp } from "../middlewares/security.js";
import { receiveResume } from "../middlewares/upload.js";
import type { Deps } from "../types.js";

export function careersRoutes(deps: Deps) {
  const controller = new CareersController(deps);
  return Router().post("/careers", rateLimitPerIp(3), receiveResume, controller.create);
}
