#!/usr/bin/env node
// Create (or reset the password of) an administrator account.
//
// Interactive:      npm run create-admin
// Non-interactive:  ADMIN_NAME="Jane" ADMIN_EMAIL=jane@example.com \
//                   ADMIN_PASSWORD='a-long-password' npm run create-admin
//
// If the email already exists, its name and password are updated - this is
// also how you recover a forgotten admin password from the server.
require("dotenv").config();

const readline = require("readline");
const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");

const MIN_PASSWORD = 10;

function ask(rl, question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden) return rl.question(question, (a) => resolve(a.trim()));
    // Hide password characters as they are typed.
    const output = rl.output;
    const write = output.write.bind(output);
    rl.question(question, (answer) => {
      output.write = write;
      output.write("\n");
      resolve(answer);
    });
    output.write = (chunk) => {
      if (typeof chunk === "string" && chunk.startsWith(question)) {
        return write(chunk);
      }
      return write("");
    };
  });
}

async function main() {
  let name = process.env.ADMIN_NAME;
  let email = process.env.ADMIN_EMAIL;
  let password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    name = name || (await ask(rl, "Admin name: "));
    email = email || (await ask(rl, "Admin email: "));
    password = await ask(rl, `Password (min ${MIN_PASSWORD} characters): `, {
      hidden: true,
    });
    const confirm = await ask(rl, "Confirm password: ", { hidden: true });
    rl.close();
    if (password !== confirm) throw new Error("Passwords do not match.");
  }

  name = (name || "Administrator").trim().slice(0, 120);
  email = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Please enter a valid email address.");
  }
  if (!password || password.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "frontier_marketplace",
  });

  const hash = await bcrypt.hash(password, 12);
  const [result] = await conn.query(
    `INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), password_hash = VALUES(password_hash)`,
    [name, email, hash],
  );
  await conn.end();

  console.log(
    result.affectedRows === 1
      ? `Admin account created for ${email}.`
      : `Admin account ${email} already existed - name and password updated.`,
  );
}

main().catch((error) => {
  console.error("Could not create admin:", error.message);
  process.exit(1);
});
