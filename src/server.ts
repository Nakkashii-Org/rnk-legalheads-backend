import mongoose from "mongoose";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { logger } from "./lib/logger.js";
import { createMailProvider } from "./services/mail.js";
import { createImageStorage } from "./services/images.js";
import { createStorage } from "./services/storage.js";

async function main() {
  const config = loadConfig();
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  logger.info("db.connected");

  const app = createApp({ config, mail: createMailProvider(config), storage: createStorage(config), images: createImageStorage(config) });
  const server = app.listen(config.port, "0.0.0.0", () =>
    logger.info("server.started", { port: config.port, env: config.env, mail: config.mail.transport, storage: config.storage.driver }),
  );

  const shutdown = () => {
    server.close(() => void mongoose.disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  if (error instanceof ConfigError) console.error(error.message);
  else logger.error("server.failed_to_start", { error: (error as Error).name, message: (error as Error).message });
  process.exit(1);
});
