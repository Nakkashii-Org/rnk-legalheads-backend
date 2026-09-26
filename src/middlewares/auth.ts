import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "../models/User.js";
import { User } from "../models/User.js";
import { findSession } from "../services/auth.js";

export type AuthUser = { id: string; name: string; email: string; roles: Role[] };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Only fully signed-in users (password and 6-digit code) of active accounts get through. Every
 * request refreshes the idle timer. The server checks this on every call; the UI only mirrors it.
 */
export const requireAuth: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const session = await findSession(req);
  if (!session?.mfaPassed) return void res.status(401).json({ error: "not_signed_in" });
  const user = await User.findById(session.userId).lean();
  if (!user || user.status !== "active") {
    await session.deleteOne();
    return void res.status(401).json({ error: "not_signed_in" });
  }
  session.lastSeenAt = new Date();
  await session.save();
  req.user = { id: String(user._id), name: user.name, email: user.email, roles: user.roles as Role[] };
  next();
};

/** Allows the request only if the user has at least one of the roles (Administrators always pass). */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, res, next) => {
    const mine = req.user?.roles ?? [];
    if (mine.includes("admin") || roles.some((r) => mine.includes(r))) return next();
    res.status(403).json({ error: "forbidden" });
  };
