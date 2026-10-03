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
//   5. upgrades earlier v2 databases to animal categories (Animal ->
//      Production Purpose -> Breed): existing purposes become Cattle's;
//   6. seeds the animal / purpose / breed reference list when the animals
//      table is empty (new install, or the first upgrade to animals).
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

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

  // Decided before step 4 adds "Cattle", so an upgrade still gets the
  // other animals seeded.
  const [[{ animalCount }]] = await conn.query("SELECT COUNT(*) AS animalCount FROM animals");
  const seedTaxonomy = Number(animalCount) === 0;

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

  // --- 4. Upgrade to animal categories -------------------------------------
  // Databases set up before animals existed have categories (Dairy, Beef,
  // Dual-Purpose) without an animal. They were all cattle, so attach them
  // to "Cattle"; breeds and listings keep pointing at the same rows.
  if (!(await columnExists(conn, "categories", "animal_id"))) {
    await conn.query(
      `INSERT IGNORE INTO animals (name, description, sort_order)
       VALUES ('Cattle', 'Dairy, beef and dual-purpose cattle.', 1)`,
    );
    const [[cattle]] = await conn.query("SELECT id FROM animals WHERE name = 'Cattle'");
    await conn.query("ALTER TABLE categories ADD COLUMN animal_id INT UNSIGNED NULL AFTER id");
    await conn.query("UPDATE categories SET animal_id = ?", [cattle.id]);
    await conn.query(
      `ALTER TABLE categories
         MODIFY animal_id INT UNSIGNED NOT NULL,
         ADD CONSTRAINT fk_categories_animal FOREIGN KEY (animal_id)
           REFERENCES animals(id) ON DELETE RESTRICT ON UPDATE CASCADE,
         ADD UNIQUE KEY uniq_categories_animal_name (animal_id, name)`,
    );
    const [oldIndex] = await conn.query(
      "SHOW INDEX FROM categories WHERE Key_name = 'uniq_categories_name'",
    );
    if (oldIndex.length) await conn.query("ALTER TABLE categories DROP INDEX uniq_categories_name");
    console.log("  upgraded categories to production purposes under Cattle");
  }

  // livestock_type was a cattle-only list; it now depends on the animal.
  const [[typeColumn]] = await conn.query(
    `SELECT DATA_TYPE AS type FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'livestock' AND column_name = 'livestock_type'`,
    [DB_NAME],
  );
  if (typeColumn && typeColumn.type === "enum") {
    await conn.query("ALTER TABLE livestock MODIFY livestock_type VARCHAR(40) NULL");
    console.log("  livestock type is now per animal");
  }

  if (!(await columnExists(conn, "inquiries", "animal_name"))) {
    await conn.query("ALTER TABLE inquiries ADD COLUMN animal_name VARCHAR(100) NULL AFTER livestock_title");
    await conn.query("UPDATE inquiries SET animal_name = 'Cattle' WHERE animal_name IS NULL");
    console.log("  inquiries now record the animal");
  }

  // Listings record when they were published and whether they are verified.
  if (!(await columnExists(conn, "livestock", "published_at"))) {
    await conn.query("ALTER TABLE livestock ADD COLUMN published_at DATETIME NULL AFTER status");
    await conn.query("UPDATE livestock SET published_at = created_at WHERE status = 'published'");
    console.log("  listings now record their publish date");
  }
  if (!(await columnExists(conn, "livestock", "verification"))) {
    await conn.query(
      "ALTER TABLE livestock ADD COLUMN verification ENUM('unverified', 'verified') NOT NULL DEFAULT 'unverified' AFTER published_at",
    );
    console.log("  listings can now be marked verified");
  }

  // Photos for animal categories and production purposes (shown as tiles on
  // the website, uploaded in Admin > Animals & Purposes).
  for (const table of ["animals", "categories"]) {
    if (!(await columnExists(conn, table, "image_path"))) {
      await conn.query(`ALTER TABLE ${table} ADD COLUMN image_path VARCHAR(500) NULL AFTER description`);
      console.log(`  ${table} can now have a photo`);
    }
  }

  // Production purposes now have several photos (category_images) that the
  // website slides through. Carry each single photo across as the first one.
  if (await columnExists(conn, "categories", "image_path")) {
    const [moved] = await conn.query(
      `INSERT INTO category_images (category_id, image_path, sort_order)
       SELECT c.id, c.image_path, 0 FROM categories c
       WHERE c.image_path IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM category_images ci
                         WHERE ci.category_id = c.id AND ci.image_path = c.image_path)`,
    );
    await conn.query("UPDATE categories SET image_path = NULL WHERE image_path IS NOT NULL");
    if (moved.affectedRows) console.log(`  moved ${moved.affectedRows} purpose photo(s) into the slideshow table`);
  }

  // --- 5. Reference data ----------------------------------------------------
  if (seedTaxonomy) {
    await conn.query(readSql("seed-taxonomy.sql"));
    const [[seeded]] = await conn.query(
      `SELECT (SELECT COUNT(*) FROM animals) AS animals,
              (SELECT COUNT(*) FROM categories) AS purposes,
              (SELECT COUNT(*) FROM breeds) AS breeds`,
    );
    console.log(
      `Reference data: ${seeded.animals} animals, ${seeded.purposes} production purposes, ${seeded.breeds} breeds.`,
    );
  } else {
    console.log("Animals already present - reference seed skipped.");
  }

  // --- 6. Retired reference data ------------------------------------------
  // "Indigenous/Local" production purposes were dropped from the taxonomy.
  // Remove them (and their breeds) where nothing uses them; if a listing
  // already uses one, disable it instead so that listing isn't broken.
  const [retired] = await conn.query(
    `SELECT c.id, a.name AS animal,
       (SELECT COUNT(*) FROM livestock l WHERE l.category_id = c.id) AS used
     FROM categories c JOIN animals a ON a.id = c.animal_id
     WHERE c.name = 'Indigenous/Local'`,
  );
  for (const purpose of retired) {
    if (Number(purpose.used) === 0) {
      await conn.query("DELETE FROM breeds WHERE category_id = ?", [purpose.id]);
      await conn.query("DELETE FROM categories WHERE id = ?", [purpose.id]);
      console.log(`  removed ${purpose.animal} > Indigenous/Local`);
      if (purpose.animal === "Poultry") {
        // Close the gap it left in poultry's display order.
        await conn.query(
          `UPDATE categories c JOIN animals a ON a.id = c.animal_id
           SET c.sort_order = 4
           WHERE a.name = 'Poultry' AND c.name = 'Breeding' AND c.sort_order = 5`,
        );
      }
    } else {
      const [result] = await conn.query(
        "UPDATE categories SET status = 'disabled' WHERE id = ? AND status <> 'disabled'",
        [purpose.id],
      );
      if (result.affectedRows) {
        console.log(`  disabled ${purpose.animal} > Indigenous/Local (used by ${purpose.used} listing(s) - edit them, then delete it in Admin)`);
      }
    }
  }
  // Seeded animal descriptions that mentioned "indigenous" (left alone if an
  // admin has since rewritten them).
  for (const [name, from, to] of [
    ["Goats", "Meat, dairy, dual-purpose and indigenous goats.", "Meat, dairy and dual-purpose goats."],
    ["Sheep", "Meat, wool, dual-purpose and indigenous sheep.", "Meat, wool and dual-purpose sheep."],
    ["Pigs", "Meat, commercial and indigenous pigs.", "Meat and commercial pigs."],
    ["Poultry", "Layers, broilers, dual-purpose, indigenous and breeding stock.", "Layers, broilers, dual-purpose and breeding stock."],
  ]) {
    await conn.query("UPDATE animals SET description = ? WHERE name = ? AND description = ?", [to, name, from]);
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
