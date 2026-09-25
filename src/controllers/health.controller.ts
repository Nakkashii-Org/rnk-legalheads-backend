import type { Request, Response } from "express";
import mongoose from "mongoose";

export class HealthController {
  /** GET /api/health: readiness only; no keys, counts or personal data (guide p.158). */
  check = (_req: Request, res: Response) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({ status: db ? "ok" : "unavailable" });
  };
}
