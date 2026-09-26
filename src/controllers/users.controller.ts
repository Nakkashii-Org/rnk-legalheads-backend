import type { Request, Response } from "express";
import { Types } from "mongoose";
import { logger, maskEmail } from "../lib/logger.js";
import { Session } from "../models/Session.js";
import { ROLES, User, type Role } from "../models/User.js";
import { audit, issueInvite, issuePasswordReset } from "../services/auth.js";
import { inviteEmail, passwordResetEmail } from "../services/templates.js";
import type { Deps } from "../types.js";
import { EMAIL_PATTERN } from "../validation/common.js";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const rolesFrom = (v: unknown): Role[] | undefined =>
  Array.isArray(v) && v.every((r) => (ROLES as readonly string[]).includes(r)) ? ([...new Set(v)] as Role[]) : undefined;

function view(u: InstanceType<typeof User>) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    roles: u.roles,
    status: u.status,
    mfaEnabled: Boolean(u.mfa?.enabled),
    locked: Boolean(u.lockedUntil && u.lockedUntil > new Date()),
    lastLoginAt: u.lastLoginAt,
    inviteExpiresAt: u.status === "invited" ? u.invite?.expiresAt : undefined,
  };
}

/** Users and roles (B4). Administrators only; enforced by the route's requireRole("admin"). */
export class UsersController {
  constructor(private readonly deps: Deps) {}

  /** There must always be at least one active Administrator, so the CMS can't lock itself out. */
  private async wouldRemoveLastAdmin(target: InstanceType<typeof User>, nextRoles: string[], nextStatus: string) {
    const isAdminNow = target.status === "active" && target.roles.includes("admin");
    const staysAdmin = nextStatus === "active" && nextRoles.includes("admin");
    if (!isAdminNow || staysAdmin) return false;
    return (await User.countDocuments({ status: "active", roles: "admin", _id: { $ne: target._id } })) === 0;
  }

  private async sendInvite(user: InstanceType<typeof User>, invitedBy: string) {
    const link = await issueInvite(user._id, this.deps.config);
    try {
      await this.deps.mail.sendEmail(inviteEmail({ to: user.email, name: user.name, invitedBy, link, roles: user.roles }));
      return true;
    } catch (error) {
      logger.error("users.invite_email_failed", { to: maskEmail(user.email), error: (error as Error).name });
      return false;
    }
  }

  /** GET /api/admin/users */
  list = async (_req: Request, res: Response) => {
    const users = await User.find().sort({ status: 1, name: 1 });
    res.json({ users: users.map(view) });
  };

  /** POST /api/admin/users { name, email, roles } → invited; the invitation email is sent. */
  invite = async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.name).trim();
    const email = str(b.email).trim().toLowerCase();
    const roles = rolesFrom(b.roles);
    const errors: Record<string, string> = {};
    if (name.length < 2 || name.length > 100 || /[\r\n]/.test(name)) errors["u-name"] = "Enter the person's full name.";
    if (!EMAIL_PATTERN.test(email) || email.length > 254) errors["u-email"] = "Enter a valid work email address.";
    if (!roles || roles.length === 0) errors["u-roles"] = "Choose at least one role.";
    if (!errors["u-email"] && (await User.exists({ email }))) errors["u-email"] = "This person already has an account.";
    if (Object.keys(errors).length) return void res.status(422).json({ errors });

    const user = await User.create({ name, email, roles, status: "invited", createdBy: req.user!.email });
    const emailed = await this.sendInvite(user, req.user!.name);
    await audit("user.invited", { actorId: req.user!.id, actorEmail: req.user!.email, target: email, detail: `roles: ${roles!.join(", ")}` });
    res.status(201).json({ user: view(user), emailed });
  };

  /** PATCH /api/admin/users/:id { roles?, status? ("active" | "disabled") } */
  update = async (req: Request, res: Response) => {
    if (!Types.ObjectId.isValid(String(req.params.id))) return void res.status(404).json({ error: "not_found" });
    const user = await User.findById(req.params.id);
    if (!user) return void res.status(404).json({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const roles = b.roles === undefined ? user.roles : rolesFrom(b.roles);
    const status = b.status === undefined ? user.status : str(b.status);
    if (!roles || roles.length === 0) return void res.status(422).json({ errors: { roles: "Choose at least one role." } });
    if (!["active", "disabled"].includes(status) && status !== user.status) return void res.status(422).json({ errors: { status: "Status must be active or disabled." } });
    if (status === "active" && user.status === "invited") return void res.status(422).json({ errors: { status: "This person must finish setting up their account first." } });
    if (await this.wouldRemoveLastAdmin(user, roles, status))
      return void res.status(409).json({ error: "last_admin", message: "At least one active Administrator is required." });

    const changes: string[] = [];
    if (roles.join() !== user.roles.join()) changes.push(`roles: ${roles.join(", ")}`);
    if (status !== user.status) changes.push(`status: ${status}`);
    user.roles = roles;
    user.status = status as typeof user.status;
    if (status === "active") user.lockedUntil = undefined;
    await user.save();
    // Disabling someone signs them out everywhere at once.
    if (status === "disabled") await Session.deleteMany({ userId: user._id });
    if (changes.length) await audit(status === "disabled" && changes.some((c) => c.startsWith("status")) ? "user.disabled" : "user.updated", { actorId: req.user!.id, actorEmail: req.user!.email, target: user.email, detail: changes.join("; ") });
    res.json({ user: view(user) });
  };

  /** POST /api/admin/users/:id/reset-mfa → they set up a new authenticator at their next sign-in. */
  resetMfa = async (req: Request, res: Response) => {
    if (!Types.ObjectId.isValid(String(req.params.id))) return void res.status(404).json({ error: "not_found" });
    const user = await User.findById(req.params.id);
    if (!user) return void res.status(404).json({ error: "not_found" });
    user.set("mfa", { enabled: false, lastUsedStep: -1 });
    await user.save();
    await Session.deleteMany({ userId: user._id });
    await audit("user.mfa_reset", { actorId: req.user!.id, actorEmail: req.user!.email, target: user.email });
    res.json({ user: view(user) });
  };

  /** POST /api/admin/users/:id/password-reset → emails a one-hour link to choose a new password. */
  sendPasswordReset = async (req: Request, res: Response) => {
    if (!Types.ObjectId.isValid(String(req.params.id))) return void res.status(404).json({ error: "not_found" });
    const user = await User.findById(req.params.id);
    if (!user) return void res.status(404).json({ error: "not_found" });
    if (user.status !== "active") return void res.status(409).json({ error: "not_active", message: "Only active accounts can reset a password. Use Resend invitation for invited people." });
    const link = await issuePasswordReset(user._id, this.deps.config);
    let emailed = true;
    try {
      await this.deps.mail.sendEmail(passwordResetEmail({ to: user.email, name: user.name, sentBy: req.user!.name, link }));
    } catch (error) {
      emailed = false;
      logger.error("users.password_reset_email_failed", { to: maskEmail(user.email), error: (error as Error).name });
    }
    await audit("user.password_reset_sent", { actorId: req.user!.id, actorEmail: req.user!.email, target: user.email });
    res.json({ user: view(user), emailed });
  };

  /** POST /api/admin/users/:id/resend-invite → a new link (the old one stops working). */
  resendInvite = async (req: Request, res: Response) => {
    if (!Types.ObjectId.isValid(String(req.params.id))) return void res.status(404).json({ error: "not_found" });
    const user = await User.findById(req.params.id);
    if (!user) return void res.status(404).json({ error: "not_found" });
    if (user.status !== "invited") return void res.status(409).json({ error: "already_active" });
    const emailed = await this.sendInvite(user, req.user!.name);
    await audit("user.invite_resent", { actorId: req.user!.id, actorEmail: req.user!.email, target: user.email });
    res.json({ user: view(user), emailed });
  };
}
