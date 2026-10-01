#!/usr/bin/env node
// Sends a sample inquiry notification using the SMTP settings in .env, so
// you can confirm email delivery works before going live:
//
//   npm run test-email
require("dotenv").config();

const { sendInquiryNotification, recipients } = require("../server/services/mailer");

(async () => {
  console.log(`Sending test notification to: ${recipients().join(", ")}`);
  console.log(`Via SMTP ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}\n`);
  const info = await sendInquiryNotification({
    livestock_title: "TEST - Frontier email check",
    category_name: "Beef",
    breed_name: "Boran",
    full_name: "Frontier Email Test",
    phone: "+260 000 000 000",
    email: process.env.SMTP_USER || "test@example.com",
    message:
      "This is a test message from `npm run test-email`. If you received it, inquiry notifications are working.",
    created_at: new Date(),
  });
  console.log("Sent. Message id:", info.messageId);
  console.log("Accepted by server for:", info.accepted.join(", "));
})().catch((error) => {
  console.error("Email test failed:", error.message);
  process.exit(1);
});
