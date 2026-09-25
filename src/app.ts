import express from "express";
import helmet from "helmet";
import { errorHandler, notFound } from "./middlewares/error.js";
import { apiRoutes } from "./routes/index.js";
import type { Deps } from "./types.js";

export type { Deps } from "./types.js";

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  // Hops of trusted proxies in front of us (Render, the Next.js rewrite), so rate limits see the visitor's IP.
  app.set("trust proxy", deps.config.trustProxy);
  app.use(helmet());
  app.use(express.json({ limit: "16kb" }));

  app.use("/api", apiRoutes(deps));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
