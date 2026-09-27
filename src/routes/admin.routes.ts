import { Router } from "express";
import { AdminContentController } from "../controllers/adminContent.controller.js";
import { AuditController } from "../controllers/audit.controller.js";
import { AuthController } from "../controllers/auth.controller.js";
import { ContentWriteController } from "../controllers/contentWrite.controller.js";
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
  const content = new AdminContentController();
  const write = new ContentWriteController();
  const router = Router();

  // 1. No session needed
  router.post("/admin/auth/login", rateLimitPerIp(10), auth.login);
  router.post("/admin/auth/mfa", rateLimitPerIp(10), auth.mfa);
  router.post("/admin/auth/logout", auth.logout);
  router.get("/admin/setup", rateLimitPerIp(30), auth.setupInfo);
  router.post("/admin/setup/password", rateLimitPerIp(20), auth.setupPassword);
  router.post("/admin/setup/verify", rateLimitPerIp(20), auth.setupVerify);
  router.get("/admin/reset", rateLimitPerIp(30), auth.resetInfo);
  router.post("/admin/reset", rateLimitPerIp(10), auth.resetPassword);

  // 2. Signed in
  router.use("/admin", requireAuth);
  router.get("/admin/auth/me", auth.me);
  router.post("/admin/auth/logout-all", auth.logoutAll);
  // Reading content (C1): every signed-in role
  router.get("/admin/dashboard", content.dashboard);
  router.get("/admin/options", content.options);
  router.get("/admin/content", content.across);
  router.get("/admin/content/:type", content.list);
  router.get("/admin/content/:type/:id", content.one);
  // Writing drafts (C2): every signed-in role
  router.post("/admin/content/:type", write.create);
  router.patch("/admin/content/:type/:id", write.update);
  router.post("/admin/content/:type/:id/submit", write.submit);
  router.delete("/admin/content/:type/:id", write.remove);
  router.get("/admin/content/:type/:id/revisions", write.revisions);
  router.get("/admin/preview-bundle", write.previewBundle);

  // 3. Administrators only
  const admin = requireRole("admin");
  router.get("/admin/users", admin, users.list);
  router.post("/admin/users", admin, users.invite);
  router.patch("/admin/users/:id", admin, users.update);
  router.post("/admin/users/:id/reset-mfa", admin, users.resetMfa);
  router.post("/admin/users/:id/resend-invite", admin, users.resendInvite);
  router.post("/admin/users/:id/password-reset", admin, users.sendPasswordReset);
  router.get("/admin/audit", admin, auditLog.list);

  // Any other /api/admin path (content editing arrives in phase C): signed-in users get 404.
  router.use("/admin", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return router;
}
