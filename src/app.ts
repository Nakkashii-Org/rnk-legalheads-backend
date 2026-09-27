import express from "express";
import helmet from "helmet";
import { LocalImages } from "./services/images.js";
import { errorHandler, notFound } from "./middlewares/error.js";
import { requestLog } from "./middlewares/requestLog.js";
import { apiRoutes } from "./routes/index.js";
import type { Deps } from "./types.js";

export type { Deps } from "./types.js";

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  // Hops of trusted proxies in front of us (Render, the Next.js rewrite), so rate limits see the visitor's IP.
  app.set("trust proxy", deps.config.trustProxy);
  // Development: print every API call in the terminal (never in production or tests).
  if (deps.config.env === "development") app.use(requestLog);
  app.use(helmet());
  // CMS content saves carry whole articles; every other request stays small.
  app.use("/api/admin/content", express.json({ limit: "512kb" }));
  app.use(express.json({ limit: "16kb" }));
  // Development: media-library images stored on disk are served here (Cloudinary serves them in production).
  if (deps.images instanceof LocalImages)
    app.use("/api/media-files", express.static(deps.images.root, { fallthrough: false, index: false, dotfiles: "deny", maxAge: "1d" }));

  app.use("/api", apiRoutes(deps));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
