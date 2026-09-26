import type { Request, Response } from "express";
import { AuditEvent } from "../models/AuditEvent.js";

const PAGE_SIZE = 50;

/** Audit log (B5). Administrators only. Newest first. */
export class AuditController {
  /** GET /api/admin/audit?page=&action= */
  list = async (req: Request, res: Response) => {
    const action = typeof req.query.action === "string" && /^[a-z._]{1,60}$/.test(req.query.action) ? req.query.action : undefined;
    const filter = action ? { action } : {};
    const total = await AuditEvent.countDocuments(filter);
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1), pageCount);
    const events = await AuditEvent.find(filter)
      .sort({ at: -1, _id: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean();
    res.json({
      events: events.map((e) => ({ id: String(e._id), at: e.at, action: e.action, actor: e.actorEmail, target: e.target, detail: e.detail })),
      total,
      page,
      pageCount,
    });
  };
}
