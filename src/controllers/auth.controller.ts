import type { Request, Response } from "express";
import { sha256 } from "../lib/ids.js";
import { logger, maskEmail } from "../lib/logger.js";
import { dummyPasswordHash, hashPassword, passwordProblem, verifyPassword } from "../lib/secrets.js";
import { verifyTotp } from "../lib/totp.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import {
  LOCK_TTL,
  MAX_FAILED_LOGINS,
  SESSION_TTL,
  audit,
  clearSessionCookie,
  createSession,
  findInvitedUser,
  findResetUser,
  findSession,
  readSecret,
  readSessionToken,
  setSessionCookie,
  startMfaEnrolment,
} from "../services/auth.js";
import type { Deps } from "../types.js";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const body = (req: Request) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});

/**
 * CMS sign-in (A01, plan section 7): password, then a 6-digit authenticator code. Named accounts
 * only, set up through a one-time invitation link. Errors never reveal whether an email exists.
 */
export class AuthController {
  constructor(private readonly deps: Deps) {}

  /** POST /api/admin/auth/login { email, password } → { step: "mfa" } or { step: "enroll", qr, secret } */
  login = async (req: Request, res: Response) => {
    const email = str(body(req).email).trim().toLowerCase();
    const password = str(body(req).password);
    const user = email ? await User.findOne({ email }) : null;

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await audit("auth.login_blocked_locked", { actorEmail: user.email });
      return void res.status(429).json({ error: "locked" });
    }

    const ok = user && user.status === "active" ? await verifyPassword(user.passwordHash, password) : (await verifyPassword(await dummyPasswordHash(), password), false);
    if (!user || !ok) {
      if (user) {
        user.failedLogins = (user.failedLogins ?? 0) + 1;
        if (user.failedLogins >= MAX_FAILED_LOGINS) {
          user.lockedUntil = new Date(Date.now() + LOCK_TTL);
          user.failedLogins = 0;
          await audit("auth.account_locked", { actorEmail: user.email, detail: `after ${MAX_FAILED_LOGINS} wrong attempts` });
        }
        await user.save();
      }
      await audit("auth.login_failed", { actorEmail: user?.email, detail: user ? "wrong password or inactive account" : `unknown email ${maskEmail(email)}` });
      return void res.status(401).json({ error: "invalid_credentials" });
    }

    user.failedLogins = 0;
    user.lockedUntil = undefined;

    const { token, ttl } = await createSession(user._id, false);
    setSessionCookie(res, this.deps.config, token, ttl);

    if (user.mfa?.enabled && user.mfa.secret) {
      await user.save();
      return void res.json({ step: "mfa" });
    }
    // 2-step verification was reset by an Administrator: set it up again now.
    const { pendingSecret, enrolment } = await startMfaEnrolment(user.email, this.deps.config);
    user.set("mfa.pendingSecret", pendingSecret);
    await user.save();
    res.json({ step: "enroll", ...enrolment });
  };

  /** POST /api/admin/auth/mfa { code } → full session (a fresh cookie, so the pending one can't be reused). */
  mfa = async (req: Request, res: Response) => {
    const session = await findSession(req);
    if (!session || session.mfaPassed) return void res.status(401).json({ error: "start_again" });
    const user = await User.findById(session.userId);
    if (!user || user.status !== "active") return void res.status(401).json({ error: "start_again" });

    const enrolling = !user.mfa?.enabled;
    const sealed = enrolling ? user.mfa?.pendingSecret : user.mfa?.secret;
    const step = sealed ? verifyTotp(readSecret(sealed, this.deps.config), str(body(req).code).trim(), user.mfa?.lastUsedStep ?? -1) : undefined;

    if (step === undefined) {
      session.mfaFailures += 1;
      await audit("auth.mfa_failed", { actorId: String(user._id), actorEmail: user.email });
      if (session.mfaFailures >= MAX_FAILED_LOGINS) {
        await session.deleteOne();
        clearSessionCookie(res, this.deps.config);
        return void res.status(401).json({ error: "start_again" });
      }
      await session.save();
      return void res.status(401).json({ error: "invalid_code" });
    }

    if (enrolling) {
      user.set("mfa.secret", user.mfa!.pendingSecret);
      user.set("mfa.pendingSecret", undefined);
      user.set("mfa.enabled", true);
    }
    user.set("mfa.lastUsedStep", step);
    user.lastLoginAt = new Date();
    await user.save();

    await session.deleteOne();
    const { token, ttl } = await createSession(user._id, true);
    setSessionCookie(res, this.deps.config, token, ttl);
    await audit(enrolling ? "auth.mfa_enrolled_and_signed_in" : "auth.signed_in", { actorId: String(user._id), actorEmail: user.email });
    logger.info("auth.signed_in", { user: maskEmail(user.email) });
    res.json({ ok: true });
  };

  /** POST /api/admin/auth/logout → ends this session. */
  logout = async (req: Request, res: Response) => {
    const token = readSessionToken(req);
    if (token) {
      const session = await Session.findOneAndDelete({ tokenHash: sha256(token) });
      if (session?.mfaPassed) {
        const user = await User.findById(session.userId).lean();
        await audit("auth.signed_out", { actorId: String(session.userId), actorEmail: user?.email });
      }
    }
    clearSessionCookie(res, this.deps.config);
    res.json({ ok: true });
  };

  /** POST /api/admin/auth/logout-all → ends every session of the signed-in user (e.g. a lost laptop). */
  logoutAll = async (req: Request, res: Response) => {
    await Session.deleteMany({ userId: req.user!.id });
    clearSessionCookie(res, this.deps.config);
    await audit("auth.signed_out_everywhere", { actorId: req.user!.id, actorEmail: req.user!.email });
    res.json({ ok: true });
  };

  /** GET /api/admin/auth/me → the signed-in user (requireAuth has already checked the session). */
  me = (req: Request, res: Response) => {
    res.json({ user: req.user, sessionHours: SESSION_TTL / 3_600_000 });
  };

  // ---- Password reset link (sent by an Administrator) ----

  /** GET /api/admin/reset?token= → who the link is for, and whether a 6-digit code is needed. */
  resetInfo = async (req: Request, res: Response) => {
    const user = await findResetUser(req.query.token);
    if (!user) return void res.status(410).json({ error: "link_expired" });
    res.json({ name: user.name, email: user.email, codeRequired: Boolean(user.mfa?.enabled) });
  };

  /**
   * POST /api/admin/reset { token, password, code } → new password. The link alone isn't enough:
   * the person's authenticator code is also required, so a stolen mailbox can't take over the account.
   */
  resetPassword = async (req: Request, res: Response) => {
    const user = await findResetUser(body(req).token);
    if (!user) return void res.status(410).json({ error: "link_expired" });

    const password = str(body(req).password);
    const problem = passwordProblem(password, user.email);
    if (problem) return void res.status(422).json({ errors: { password: problem } });

    let step: number | undefined;
    if (user.mfa?.enabled && user.mfa.secret) {
      step = verifyTotp(readSecret(user.mfa.secret, this.deps.config), str(body(req).code).trim(), user.mfa.lastUsedStep ?? -1);
      if (step === undefined) {
        await audit("auth.password_reset_code_failed", { actorId: String(user._id), actorEmail: user.email });
        return void res.status(422).json({ errors: { code: "That code is not correct or has already been used. Wait for the next code and try again." } });
      }
    }

    user.passwordHash = await hashPassword(password);
    user.set("passwordReset", undefined);
    user.failedLogins = 0;
    user.lockedUntil = undefined;
    if (step !== undefined) user.set("mfa.lastUsedStep", step);
    await user.save();
    // Any session opened with the old password ends.
    await Session.deleteMany({ userId: user._id });
    await audit("auth.password_reset_completed", { actorId: String(user._id), actorEmail: user.email });
    res.json({ ok: true });
  };

  // ---- First-time setup from the invitation link ----

  /** GET /api/admin/setup?token= → who the invitation is for. */
  setupInfo = async (req: Request, res: Response) => {
    const user = await findInvitedUser(req.query.token);
    if (!user) return void res.status(410).json({ error: "link_expired" });
    res.json({ name: user.name, email: user.email });
  };

  /** POST /api/admin/setup/password { token, password } → sets the password and returns the QR code to scan. */
  setupPassword = async (req: Request, res: Response) => {
    const user = await findInvitedUser(body(req).token);
    if (!user) return void res.status(410).json({ error: "link_expired" });
    const password = str(body(req).password);
    const problem = passwordProblem(password, user.email);
    if (problem) return void res.status(422).json({ errors: { password: problem } });

    user.passwordHash = await hashPassword(password);
    const { pendingSecret, enrolment } = await startMfaEnrolment(user.email, this.deps.config);
    user.set("mfa.pendingSecret", pendingSecret);
    user.set("mfa.enabled", false);
    user.set("mfa.secret", undefined);
    await user.save();
    res.json(enrolment);
  };

  /** POST /api/admin/setup/verify { token, code } → account active, invitation used up, signed in. */
  setupVerify = async (req: Request, res: Response) => {
    const user = await findInvitedUser(body(req).token);
    if (!user || !user.passwordHash || !user.mfa?.pendingSecret) return void res.status(410).json({ error: "link_expired" });
    const step = verifyTotp(readSecret(user.mfa.pendingSecret, this.deps.config), str(body(req).code).trim());
    if (step === undefined) return void res.status(401).json({ error: "invalid_code" });

    user.set("mfa.secret", user.mfa.pendingSecret);
    user.set("mfa.pendingSecret", undefined);
    user.set("mfa.enabled", true);
    user.set("mfa.lastUsedStep", step);
    user.set("invite", undefined);
    user.status = "active";
    user.lastLoginAt = new Date();
    await user.save();

    const { token, ttl } = await createSession(user._id, true);
    setSessionCookie(res, this.deps.config, token, ttl);
    await audit("user.setup_completed", { actorId: String(user._id), actorEmail: user.email });
    res.json({ ok: true });
  };
}
