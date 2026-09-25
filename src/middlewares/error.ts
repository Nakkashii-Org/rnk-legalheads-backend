import type { ErrorRequestHandler, RequestHandler } from "express";
import { logger } from "../lib/logger.js";

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "not_found" });
};

/** Last-resort handler: a generic error, never a stack trace or provider detail (guide p.158). */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const status = typeof error?.status === "number" ? error.status : typeof error?.statusCode === "number" ? error.statusCode : 500;
  if (status === 400 && error?.type === "entity.parse.failed") return void res.status(400).json({ error: "invalid_json" });
  if (status === 413) return void res.status(413).json({ error: "too_large" });
  logger.error("request.failed", { method: req.method, path: req.path, status, error: error?.name });
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: "server_error" });
};
