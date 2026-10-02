#!/usr/bin/env node
// Checks the email settings in .env and sends a sample inquiry notification,
// so you can confirm delivery works:
//
//   npm run test-email
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { sendInquiryNotification, emailConfig, verifyEmail } = require("../server/services/mailer");

(async () => {
  const config = emailConfig();
  console.log("Email settings from .env");
  console.log(`  SMTP_HOST   ${config.host || "(missing)"}`);
  console.log(`  SMTP_PORT   ${config.port} (${config.secure ? "SSL" : "STARTTLS"})`);
  console.log(`  SMTP_USER   ${config.user || "(missing)"}`);
  console.log(`  SMTP_PASS   ${config.pass ? `set (${config.pass.length} characters)` : "(missing)"}`);
  console.log(`  Recipients  ${config.recipients.join(", ")}\n`);

  if (!config.configured) {
    console.error(`Not set up: ${config.problems.join("; ")}.`);
    process.exit(1);
  }

  process.stdout.write("Connecting and signing in... ");
  const check = await verifyEmail();
  if (!check.ok) {
    console.log("failed.\n");
    console.error(check.message);
    process.exit(1);
  }
  console.log("ok.");

  process.stdout.write("Sending test notification... ");
  const info = await sendInquiryNotification({
    livestock_title: "TEST - Frontier email check",
    animal_name: "Cattle",
    category_name: "Beef",
    breed_name: "Boran",
    full_name: "Frontier Email Test",
    phone: "+260 000 000 000",
    email: config.user,
    message:
      "This is a test message from `npm run test-email`. If you received it, inquiry notifications are working.",
    created_at: new Date(),
  });
  console.log("sent.");
  console.log(`Accepted for: ${info.accepted.join(", ")}`);
  console.log("Check both inboxes (and the spam folder the first time).");
})().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
