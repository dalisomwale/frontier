#!/usr/bin/env node
// Database setup & migration for Frontier Marketplace v2.
//
//   npm run db:setup
//
// Safe to run on every deploy. It:
//   1. creates the database if it does not exist (when the MySQL user may);
//   2. archives v1 tables (users, listings, messages, ...) by renaming them to
//      legacy_v1_* - nothing is dropped, so old data can still be inspected;
//   3. creates the v2 tables (schema.sql) if they are missing;
//   4. carries v1 admin accounts (users.role = 'admin') across into `admins`,
//      keeping their existing password hashes so they can still sign in;
//   5. seeds the category/breed reference list when categories is empty.
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const DB_NAME = process.env.DB_NAME || "frontier_marketplace";
const LEGACY_PREFIX = "legacy_v1_";
const LEGACY_TABLES = [
  "reports",
  "favorites",
  "messages",
  "listing_documents",
  "listing_media",
  "inquiries",
  "listings",
  "users",
];

function readSql(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",
    [DB_NAME, table],
  );
  return rows.length > 0;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?",
    [DB_NAME, table, column],
  );
  return rows.length > 0;
}

async function main() {
  const base = {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    multipleStatements: true,
    charset: "utf8mb4",
  };

  const server = await mysql.createConnection(base);
  try {
    await server.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } catch (error) {
    console.warn(
      `Could not create database "${DB_NAME}" (${error.code}). Continuing, assuming it already exists.`,
    );
  }
  await server.end();

  const conn = await mysql.createConnection({ ...base, database: DB_NAME });
  console.log(`Connected to ${base.host}:${base.port}/${DB_NAME}`);

  // --- 1. Archive v1 tables -------------------------------------------------
  // v1's `inquiries` had buyer_id/seller_id; v2's does not. Only archive it
  // when it is the v1 shape, so re-running this script never touches v2 data.
  const legacyInquiries =
    (await tableExists(conn, "inquiries")) &&
    (await columnExists(conn, "inquiries", "buyer_id"));

  const toArchive = [];
  for (const table of LEGACY_TABLES) {
    if (table === "inquiries" && !legacyInquiries) continue;
    if (await tableExists(conn, table)) toArchive.push(table);
  }

  if (toArchive.length) {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of toArchive) {
      let target = LEGACY_PREFIX + table;
      if (await tableExists(conn, target)) target += `_${Date.now()}`;
      await conn.query(`RENAME TABLE \`${table}\` TO \`${target}\``);
      console.log(`  archived v1 table ${table} -> ${target}`);
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  }

  // --- 2. v2 schema ---------------------------------------------------------
  await conn.query(readSql("schema.sql"));
  console.log("Schema is up to date.");

  // --- 3. Carry v1 admins across -------------------------------------------
  const legacyUsers = LEGACY_PREFIX + "users";
  if (await tableExists(conn, legacyUsers)) {
    const [result] = await conn.query(
      `INSERT IGNORE INTO admins (name, email, password_hash, created_at)
       SELECT name, LOWER(email), password_hash, created_at FROM \`${legacyUsers}\`
       WHERE role = 'admin' AND status = 'active'`,
    );
    if (result.affectedRows) {
      console.log(`  carried over ${result.affectedRows} v1 admin account(s)`);
    }
  }

  // --- 4. Reference data ----------------------------------------------------
  const [[{ count }]] = await conn.query(
    "SELECT COUNT(*) AS count FROM categories",
  );
  if (Number(count) === 0) {
    await conn.query(readSql("seed-categories.sql"));
    const [[seeded]] = await conn.query(
      "SELECT (SELECT COUNT(*) FROM categories) AS categories, (SELECT COUNT(*) FROM breeds) AS breeds",
    );
    console.log(
      `Seeded ${seeded.categories} categories and ${seeded.breeds} breeds.`,
    );
  } else {
    console.log("Categories already present - reference seed skipped.");
  }

  const [[{ admins }]] = await conn.query(
    "SELECT COUNT(*) AS admins FROM admins",
  );
  await conn.end();

  console.log("\nDatabase ready.");
  if (Number(admins) === 0) {
    console.log(
      "No administrator exists yet. Create one with:  npm run create-admin",
    );
  }
}

main().catch((error) => {
  console.error("\nDatabase setup failed:", error.message);
  process.exit(1);
});
