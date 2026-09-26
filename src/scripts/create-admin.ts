/**
 * Creates the first CMS Administrator (or gives an existing account a fresh setup link).
 *
 *   npm run create-admin -- --email you@example.com --name "Your Name"
 *
 * Prints a one-time setup link (valid 72 hours) and, when email is configured, emails it too.
 * The person opens it, chooses a password and connects an authenticator app. Nobody else ever
 * sees their password.
 */
import mongoose from "mongoose";
import { loadConfig } from "../config.js";
import { User } from "../models/User.js";
import { audit, issueInvite } from "../services/auth.js";
import { createMailProvider } from "../services/mail.js";
import { inviteEmail } from "../services/templates.js";
import { EMAIL_PATTERN } from "../validation/common.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name")?.trim();
  if (!email || !EMAIL_PATTERN.test(email) || !name) {
    console.error('Usage: npm run create-admin -- --email you@example.com --name "Your Name"');
    process.exit(1);
  }

  const config = loadConfig();
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  await User.init();

  let user = await User.findOne({ email });
  if (user) {
    if (!user.roles.includes("admin")) user.roles.push("admin");
    // An existing account keeps its password until the new link is used.
    if (user.status === "disabled") user.status = user.passwordHash ? "active" : "invited";
    await user.save();
    console.log(`Existing account ${email}: Administrator role ensured.`);
  } else {
    user = await User.create({ name, email, roles: ["admin"], status: "invited", createdBy: "create-admin command" });
    console.log(`Created Administrator ${email}.`);
  }

  // Active accounts that just need a new link are moved back to "invited" setup.
  if (user.status === "active") {
    user.status = "invited";
    await user.save();
  }
  const link = await issueInvite(user._id, config);
  await audit("user.admin_created_by_command", { target: email });

  try {
    await createMailProvider(config).sendEmail(inviteEmail({ to: email, name: user.name, invitedBy: "The website administrator", link, roles: user.roles }));
    console.log(`Setup email sent to ${email}${config.mail.transport === "log" ? " (development: printed above instead of sent)" : ""}.`);
  } catch {
    console.log("The setup email could not be sent; use the link below.");
  }
  console.log(`\nSetup link (valid 72 hours, works once):\n${link}\n`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
