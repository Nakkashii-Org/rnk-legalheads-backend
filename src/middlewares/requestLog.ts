import type { RequestHandler } from "express";

/**
 * Development only: one line per API call in the backend terminal, e.g.
 *   GET /api/admin/content/services 200 12ms
 * The query string is left out, so tokens in links (?token=…) are never printed.
 * Not used in production or tests (see app.ts).
 */
export const requestLog: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const path = req.originalUrl.split("?")[0];
    const colour = res.statusCode >= 500 ? 31 : res.statusCode >= 400 ? 33 : 32;
    console.log(`\x1b[${colour}m${req.method} ${path} ${res.statusCode}\x1b[0m ${ms.toFixed(0)}ms`);
  });
  next();
};
