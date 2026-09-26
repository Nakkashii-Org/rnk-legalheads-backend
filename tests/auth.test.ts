import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { codeForStep, currentStep } from "../src/lib/totp.js";
import { AuditEvent } from "../src/models/AuditEvent.js";
import { Session } from "../src/models/Session.js";
import { User, type Role } from "../src/models/User.js";
import { issueInvite } from "../src/services/auth.js";
import { ORIGIN, clearDb, makeApp, startDb, stopDb, type FakeMail } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

type App = Awaited<ReturnType<typeof makeApp>>;
const PASSWORD = "correct horse battery staple";

const post = (agent: ReturnType<typeof request.agent>, path: string, body: object = {}) => agent.post(path).set("Origin", ORIGIN).send(body);
const tokenFrom = (link: string) => new URL(link).searchParams.get("token")!;
/** A code for a later 30-second step than any already used (the window allows +1). */
const code = (secret: string, offset = 0) => codeForStep(secret, currentStep() + offset);

/** Creates an invited user and completes setup through the API; returns a signed-in agent and the secret. */
async function setUpUser(app: App, email: string, roles: Role[]) {
  const user = await User.create({ name: `Name ${email}`, email, roles, status: "invited" });
  const token = tokenFrom(await issueInvite(user._id, app.config));
  const agent = request.agent(app.app);
  const pw = await post(agent, "/api/admin/setup/password", { token, password: PASSWORD });
  expect(pw.status).toBe(200);
  const secret: string = pw.body.secret;
  const verify = await post(agent, "/api/admin/setup/verify", { token, code: code(secret) });
  expect(verify.status).toBe(200);
  return { agent, secret, user };
}

async function signIn(app: App, email: string, secret: string, offset = 1) {
  const agent = request.agent(app.app);
  const login = await post(agent, "/api/admin/auth/login", { email, password: PASSWORD });
  expect(login.body).toEqual({ step: "mfa" });
  const mfa = await post(agent, "/api/admin/auth/mfa", { code: code(secret, offset) });
  expect(mfa.status).toBe(200);
  return agent;
}

describe("invitation setup (B1)", () => {
  it("sets a password, connects the authenticator and signs in", async () => {
    const app = await makeApp();
    const user = await User.create({ name: "Dilip Kumar", email: "dilip@example.com", roles: ["admin"], status: "invited" });
    const token = tokenFrom(await issueInvite(user._id, app.config));
    const agent = request.agent(app.app);

    expect((await agent.get(`/api/admin/setup?token=${token}`)).body).toEqual({ name: "Dilip Kumar", email: "dilip@example.com" });
    expect((await post(agent, "/api/admin/setup/password", { token, password: "short" })).body.errors.password).toBe("Use at least 12 characters.");
    expect((await post(agent, "/api/admin/setup/password", { token, password: "dilip-and-more-words" })).body.errors.password).toContain("email");

    const pw = await post(agent, "/api/admin/setup/password", { token, password: PASSWORD });
    expect(pw.body.qr).toMatch(/^data:image\/png;base64,/);
    expect(pw.body.otpauthUrl).toContain("otpauth://totp/RNK%20Legalheads%20CMS");

    expect((await post(agent, "/api/admin/setup/verify", { token, code: "000000" })).status).toBe(401);
    const ok = await post(agent, "/api/admin/setup/verify", { token, code: code(pw.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.headers["set-cookie"]?.[0]).toMatch(/^rnk_admin=.*HttpOnly.*SameSite=Lax/);

    const me = await agent.get("/api/admin/auth/me");
    expect(me.body.user).toMatchObject({ email: "dilip@example.com", roles: ["admin"] });

    const saved = await User.findById(user._id).lean();
    expect(saved?.status).toBe("active");
    expect(saved?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(saved?.mfa?.secret).not.toContain(pw.body.secret);
    // The link works once.
    expect((await agent.get(`/api/admin/setup?token=${token}`)).status).toBe(410);
  });

  it("expired or unknown links are refused", async () => {
    const app = await makeApp();
    const user = await User.create({ name: "X Y", email: "x@example.com", roles: ["admin"] });
    const token = tokenFrom(await issueInvite(user._id, app.config));
    await User.updateOne({ _id: user._id }, { "invite.expiresAt": new Date(Date.now() - 1000) });
    expect((await request(app.app).get(`/api/admin/setup?token=${token}`)).status).toBe(410);
    expect((await request(app.app).get("/api/admin/setup?token=nonsense")).status).toBe(410);
  });
});

describe("sign-in (B2)", () => {
  it("password then code; the same code can't be used twice", async () => {
    const app = await makeApp();
    const { secret } = await setUpUser(app, "a@example.com", ["admin"]);
    const agent = request.agent(app.app);
    await post(agent, "/api/admin/auth/login", { email: "a@example.com", password: PASSWORD });
    // After the password only, the CMS is still closed.
    expect((await agent.get("/api/admin/auth/me")).status).toBe(401);
    // The code used during setup (step 0) is refused as a replay.
    expect((await post(agent, "/api/admin/auth/mfa", { code: code(secret, 0) })).status).toBe(401);
    expect((await post(agent, "/api/admin/auth/mfa", { code: code(secret, 1) })).status).toBe(200);
    expect((await agent.get("/api/admin/auth/me")).status).toBe(200);
  });

  it("wrong email and wrong password look the same", async () => {
    const app = await makeApp();
    await setUpUser(app, "b@example.com", ["contributor"]);
    const a = await post(request.agent(app.app), "/api/admin/auth/login", { email: "nobody@example.com", password: PASSWORD });
    const b = await post(request.agent(app.app), "/api/admin/auth/login", { email: "b@example.com", password: "wrong password here" });
    expect([a.status, a.body]).toEqual([401, { error: "invalid_credentials" }]);
    expect([b.status, b.body]).toEqual([401, { error: "invalid_credentials" }]);
  });

  it("locks the account after 5 wrong passwords", async () => {
    const app = await makeApp();
    await setUpUser(app, "c@example.com", ["contributor"]);
    for (let i = 0; i < 5; i++) await post(request.agent(app.app), "/api/admin/auth/login", { email: "c@example.com", password: "wrong password here" });
    const res = await post(request.agent(app.app), "/api/admin/auth/login", { email: "c@example.com", password: PASSWORD });
    expect([res.status, res.body.error]).toEqual([429, "locked"]);
    expect(await AuditEvent.countDocuments({ action: "auth.account_locked" })).toBe(1);
  });

  it("ends the attempt after 5 wrong codes", async () => {
    const app = await makeApp();
    await setUpUser(app, "d@example.com", ["contributor"]);
    const agent = request.agent(app.app);
    await post(agent, "/api/admin/auth/login", { email: "d@example.com", password: PASSWORD });
    for (let i = 0; i < 4; i++) expect((await post(agent, "/api/admin/auth/mfa", { code: "123456" })).body.error).toBe("invalid_code");
    expect((await post(agent, "/api/admin/auth/mfa", { code: "123456" })).body.error).toBe("start_again");
  });

  it("sign out, idle timeout, and requests from other websites", async () => {
    const app = await makeApp();
    const { agent } = await setUpUser(app, "e@example.com", ["contributor"]);
    await Session.updateMany({}, { lastSeenAt: new Date(Date.now() - 3 * 3600_000) });
    expect((await agent.get("/api/admin/auth/me")).status).toBe(401);

    const { agent: other, secret } = await setUpUser(app, "f@example.com", ["contributor"]);
    expect((await other.post("/api/admin/auth/logout").set("Origin", "https://evil.example")).status).toBe(403);
    await post(other, "/api/admin/auth/logout");
    expect((await other.get("/api/admin/auth/me")).status).toBe(401);
    expect(await AuditEvent.countDocuments({ action: "auth.signed_out" })).toBe(1);
    expect(secret).toBeTruthy();
  });
});

describe("protection and roles (B3, B4)", () => {
  it("admin APIs need a session and the Administrator role", async () => {
    const app = await makeApp();
    expect((await request(app.app).get("/api/admin/users")).status).toBe(401);
    const { agent } = await setUpUser(app, "writer@example.com", ["contributor"]);
    expect((await agent.get("/api/admin/users")).status).toBe(403);
    expect((await agent.get("/api/admin/audit")).status).toBe(403);
  });

  it("invites a user by email; duplicates and bad input are refused", async () => {
    const app = await makeApp();
    const { agent } = await setUpUser(app, "admin@example.com", ["admin"]);
    const res = await post(agent, "/api/admin/users", { name: "Priya Rao", email: "Priya@Example.com", roles: ["reviewer", "publisher"] });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "priya@example.com", status: "invited", roles: ["reviewer", "publisher"] });
    const mail = (app.mail as FakeMail).sent.at(-1)!;
    expect(mail.subject).toBe("Your invitation to the RNK Legalheads CMS");
    expect(mail.text).toMatch(/http:\/\/localhost:3000\/admin\/setup\?token=/);

    expect((await post(agent, "/api/admin/users", { name: "Priya Rao", email: "priya@example.com", roles: ["reviewer"] })).body.errors["u-email"]).toContain("already");
    expect(Object.keys((await post(agent, "/api/admin/users", { name: "", email: "x", roles: [] })).body.errors)).toEqual(["u-name", "u-email", "u-roles"]);
    expect((await post(agent, "/api/admin/users", { name: "Z Z", email: "z@example.com", roles: ["superuser"] })).status).toBe(422);
  });

  it("disabling a user signs them out at once", async () => {
    const app = await makeApp();
    const { agent: admin } = await setUpUser(app, "admin@example.com", ["admin"]);
    const { agent: writer, user } = await setUpUser(app, "writer@example.com", ["contributor"]);
    expect((await writer.get("/api/admin/auth/me")).status).toBe(200);
    const res = await admin.patch(`/api/admin/users/${user._id}`).set("Origin", ORIGIN).send({ status: "disabled" });
    expect(res.body.user.status).toBe("disabled");
    expect((await writer.get("/api/admin/auth/me")).status).toBe(401);
    expect(await AuditEvent.countDocuments({ action: "user.disabled", target: "writer@example.com" })).toBe(1);
  });

  it("the last active Administrator can't be removed", async () => {
    const app = await makeApp();
    const { agent, user } = await setUpUser(app, "only@example.com", ["admin"]);
    const res = await agent.patch(`/api/admin/users/${user._id}`).set("Origin", ORIGIN).send({ roles: ["publisher"] });
    expect([res.status, res.body.error]).toEqual([409, "last_admin"]);
    expect((await agent.patch(`/api/admin/users/${user._id}`).set("Origin", ORIGIN).send({ status: "disabled" })).status).toBe(409);
  });

  it("reset 2-step verification: the person scans a new code at next sign-in", async () => {
    const app = await makeApp();
    const { agent: admin } = await setUpUser(app, "admin@example.com", ["admin"]);
    const { user } = await setUpUser(app, "lost-phone@example.com", ["contributor"]);
    await post(admin, `/api/admin/users/${user._id}/reset-mfa`);

    const agent = request.agent(app.app);
    const login = await post(agent, "/api/admin/auth/login", { email: "lost-phone@example.com", password: PASSWORD });
    expect(login.body.step).toBe("enroll");
    expect(login.body.qr).toMatch(/^data:image\/png/);
    expect((await post(agent, "/api/admin/auth/mfa", { code: code(login.body.secret) })).status).toBe(200);
    expect(await AuditEvent.countDocuments({ action: "auth.mfa_enrolled_and_signed_in" })).toBe(1);
  });
});

describe("audit log (B5)", () => {
  it("records sign-ins and account changes, newest first, without secrets", async () => {
    const app = await makeApp();
    const { agent, secret } = await setUpUser(app, "admin@example.com", ["admin"]);
    await post(request.agent(app.app), "/api/admin/auth/login", { email: "admin@example.com", password: "wrong password here" });
    await signIn(app, "admin@example.com", secret);
    await post(agent, "/api/admin/users", { name: "New Person", email: "new@example.com", roles: ["contributor"] });

    const res = await agent.get("/api/admin/audit");
    const actions = res.body.events.map((e: { action: string }) => e.action);
    expect(actions.slice(0, 4)).toEqual(["user.invited", "auth.signed_in", "auth.login_failed", "user.setup_completed"]);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });
});
