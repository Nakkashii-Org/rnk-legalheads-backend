import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";

/**
 * Requests that change something must come from our own website (guide p.158: CSRF/origin
 * controls). Browsers always send Origin on POST; a missing or foreign origin is refused.
 */
export function requireOrigin(allowed: string[]): RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    let origin = req.get("origin");
    if (!origin) {
      try {
        origin = new URL(req.get("referer") ?? "").origin;
      } catch {}
    }
    if (origin && allowed.includes(origin)) return next();
    res.status(403).json({ error: "forbidden_origin" });
  };
}

/** Per-IP limit; the frontend shows "Too many attempts" for 429. */
export const rateLimitPerIp = (max: number, windowMinutes = 10) =>
  rateLimit({
    windowMs: windowMinutes * 60_000,
    limit: max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "rate_limited" });
    },
  });
