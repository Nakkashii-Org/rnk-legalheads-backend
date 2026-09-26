import { Router } from "express";
import { AuditController } from "../controllers/audit.controller.js";
import { AuthController } from "../controllers/auth.controller.js";
import { UsersController } from "../controllers/users.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { rateLimitPerIp } from "../middlewares/security.js";
import type { Deps } from "../types.js";

/**
 * /api/admin/*: the CMS. Three layers:
 * 1. sign-in and invitation setup (no session yet, rate limited);
 * 2. everything else needs a full session (password + 6-digit code);
 * 3. users and the audit log need the Administrator role.
 */
export function adminRoutes(deps: Deps) {
  const auth = new AuthController(deps);
  const users = new UsersController(deps);
  const auditLog = new AuditController();
  const router = Router();

  // 1. No session needed
  router.post("/admin/auth/login", rateLimitPerIp(10), auth.login);
  router.post("/admin/auth/mfa", rateLimitPerIp(10), auth.mfa);
  router.post("/admin/auth/logout", auth.logout);
  router.get("/admin/setup", rateLimitPerIp(30), auth.setupInfo);
  router.post("/admin/setup/password", rateLimitPerIp(20), auth.setupPassword);
  router.post("/admin/setup/verify", rateLimitPerIp(20), auth.setupVerify);

  // 2. Signed in
  router.use("/admin", requireAuth);
  router.get("/admin/auth/me", auth.me);
  router.post("/admin/auth/logout-all", auth.logoutAll);

  // 3. Administrators only
  const admin = requireRole("admin");
  router.get("/admin/users", admin, users.list);
  router.post("/admin/users", admin, users.invite);
  router.patch("/admin/users/:id", admin, users.update);
  router.post("/admin/users/:id/reset-mfa", admin, users.resetMfa);
  router.post("/admin/users/:id/resend-invite", admin, users.resendInvite);
  router.get("/admin/audit", admin, auditLog.list);

  // Any other /api/admin path (content editing arrives in phase C): signed-in users get 404.
  router.use("/admin", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return router;
}
