import type { Request, Response } from "express";
import type { Types } from "mongoose";
import QRCode from "qrcode";
import type { Config } from "../config.js";
import { newToken, sha256 } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
import { newTotpSecret, otpauthUrl } from "../lib/totp.js";
import { AuditEvent } from "../models/AuditEvent.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";

export const SESSION_COOKIE = "rnk_admin";
const MINUTE = 60_000;
export const PENDING_TTL = 5 * MINUTE; // time to enter the 6-digit code after the password
export const SESSION_TTL = 8 * 60 * MINUTE; // longest a session can last
export const IDLE_TTL = 2 * 60 * MINUTE; // signed out after this long without activity
export const INVITE_TTL = 72 * 60 * MINUTE;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_TTL = 15 * MINUTE;

// ---- Cookie ----

export function readSessionToken(req: Request): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** httpOnly (no JavaScript access), SameSite=Lax, Secure in production, whole site. */
export function setSessionCookie(res: Response, config: Config, token: string, ttl: number) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.env === "production", path: "/", maxAge: ttl });
}

export function clearSessionCookie(res: Response, config: Config) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: config.env === "production", path: "/" });
}

// ---- Sessions ----

export async function createSession(userId: Types.ObjectId, mfaPassed: boolean) {
  const token = newToken();
  const ttl = mfaPassed ? SESSION_TTL : PENDING_TTL;
  await Session.create({ tokenHash: sha256(token), userId, mfaPassed, expiresAt: new Date(Date.now() + ttl) });
  return { token, ttl };
}

export async function findSession(req: Request) {
  const token = readSessionToken(req);
  if (!token) return undefined;
  const session = await Session.findOne({ tokenHash: sha256(token) });
  if (!session || session.expiresAt <= new Date()) return undefined;
  if (session.mfaPassed && Date.now() - session.lastSeenAt.getTime() > IDLE_TTL) {
    await session.deleteOne();
    return undefined;
  }
  return session;
}

// ---- 2-step verification setup ----

/** A new pending secret (encrypted) plus what the user needs to add it to an authenticator app. */
export async function startMfaEnrolment(email: string, config: Config) {
  const secret = newTotpSecret();
  const url = otpauthUrl(secret, email);
  return {
    pendingSecret: encryptSecret(secret, config.mfaEncryptionKey),
    enrolment: { qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }), secret, otpauthUrl: url },
  };
}

export const readSecret = (sealed: string, config: Config) => decryptSecret(sealed, config.mfaEncryptionKey);

// ---- Invitations ----

/** Issues a fresh one-time setup link (replacing any earlier one) and returns its URL. */
export async function issueInvite(userId: Types.ObjectId, config: Config) {
  const token = newToken();
  await User.updateOne({ _id: userId }, { invite: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL) } });
  return `${config.publicSiteUrl}/admin/setup?token=${token}`;
}

export async function findInvitedUser(raw: unknown) {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(raw)) return undefined;
  const user = await User.findOne({ "invite.tokenHash": sha256(raw) });
  if (!user || user.status === "disabled" || !user.invite?.expiresAt || user.invite.expiresAt <= new Date()) return undefined;
  return user;
}

// ---- Password reset (sent by an Administrator) ----

export const RESET_TTL = 60 * MINUTE;

export async function issuePasswordReset(userId: Types.ObjectId, config: Config) {
  const token = newToken();
  await User.updateOne({ _id: userId }, { passwordReset: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL) } });
  return `${config.publicSiteUrl}/admin/reset?token=${token}`;
}

export async function findResetUser(raw: unknown) {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(raw)) return undefined;
  const user = await User.findOne({ "passwordReset.tokenHash": sha256(raw) });
  if (!user || user.status !== "active" || !user.passwordReset?.expiresAt || user.passwordReset.expiresAt <= new Date()) return undefined;
  return user;
}

// ---- Audit ----

export async function audit(action: string, fields: { actorId?: string; actorEmail?: string; target?: string; detail?: string } = {}) {
  try {
    await AuditEvent.create({ action, ...fields });
  } catch (error) {
    logger.error("audit.write_failed", { action, error: (error as Error).name });
  }
}
