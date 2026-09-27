import type { Config } from "./config.js";
import type { MailProvider } from "./services/mail.js";
import type { ImageStorage } from "./services/images.js";
import type { FileStorage } from "./services/storage.js";

/** Shared dependencies handed to every controller (makes them easy to test with fakes). */
export type Deps = { config: Config; mail: MailProvider; storage: FileStorage; images: ImageStorage };
