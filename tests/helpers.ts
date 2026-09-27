import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { LogProvider, ProviderError, type EmailMessage } from "../src/services/mail.js";
import { LocalStorage } from "../src/services/storage.js";

export const ORIGIN = "http://localhost:3000";

/** LogProvider that can be told to fail, to test the honest failure paths. */
export class FakeMail extends LogProvider {
  failSend = false;
  failOptIn = false;
  override async sendEmail(message: EmailMessage) {
    if (this.failSend) throw new ProviderError("Brevo send email failed", 502, "internal_error");
    return super.sendEmail(message);
  }
  override async startDoubleOptIn(input: { email: string; listIds: number[]; redirectionUrl: string }) {
    if (this.failOptIn) throw new ProviderError("Brevo double opt-in failed", 400, "invalid_parameter");
    return super.startDoubleOptIn(input);
  }
}

export class FakeStorage extends LocalStorage {
  fail = false;
  readonly keys: string[] = [];
  override async put(key: string, body: Buffer, contentType: string) {
    if (this.fail) throw new Error("storage down");
    this.keys.push(key);
    return super.put(key, body, contentType);
  }
}

let mongo: MongoMemoryServer | undefined;

export async function startDb() {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}

export async function stopDb() {
  await mongoose.disconnect();
  await mongo?.stop();
}

export async function clearDb() {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
}

export async function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: "test", PUBLIC_SITE_URL: ORIGIN, TRUST_PROXY: "0", ...env });
  const mail = new FakeMail();
  const storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), "rnk-test-")));
  return { app: createApp({ config, mail, storage }), mail, storage, config };
}

/** A signed-in agent (password + 6-digit code done) for a new active user with the given roles. */
export async function signedInAgent(app: Awaited<ReturnType<typeof makeApp>>, email: string, roles: ("contributor" | "reviewer" | "publisher" | "admin")[]) {
  const { default: request } = await import("supertest");
  const { hashPassword, encryptSecret } = await import("../src/lib/secrets.js");
  const { codeForStep, currentStep, newTotpSecret } = await import("../src/lib/totp.js");
  const { User } = await import("../src/models/User.js");
  const secret = newTotpSecret();
  await User.create({
    name: email.split("@")[0],
    email,
    roles,
    status: "active",
    passwordHash: await hashPassword("a long enough password"),
    mfa: { enabled: true, secret: encryptSecret(secret, app.config.mfaEncryptionKey), lastUsedStep: -1 },
  });
  const agent = request.agent(app.app);
  await agent.post("/api/admin/auth/login").set("Origin", ORIGIN).send({ email, password: "a long enough password" });
  const res = await agent.post("/api/admin/auth/mfa").set("Origin", ORIGIN).send({ code: codeForStep(secret, currentStep()) });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
  return agent;
}
