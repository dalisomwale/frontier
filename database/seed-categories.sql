-- ===========================================================================
-- Reference data: cattle categories and breeds (from the client's cattle
-- breed reference document). This is real reference data, not demo data -
-- no livestock, inquiries or admins are created here.
--
-- `npm run db:setup` only runs this when the categories table is empty, so
-- breeds an admin later deletes are not re-added on the next deploy.
-- INSERT IGNORE makes it safe to run by hand more than once.
-- ===========================================================================

INSERT IGNORE INTO categories (name, description, sort_order) VALUES
  ('Dairy', 'Breeds kept primarily for milk production.', 1),
  ('Beef', 'Breeds raised primarily for meat production.', 2),
  ('Dual-Purpose', 'Breeds suited to both milk and meat production.', 3);

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN (
  SELECT 'Holstein-Friesian' AS name UNION ALL
  SELECT 'Jersey' UNION ALL
  SELECT 'Guernsey' UNION ALL
  SELECT 'Ayrshire' UNION ALL
  SELECT 'Brown Swiss' UNION ALL
  SELECT 'Milking Shorthorn' UNION ALL
  SELECT 'Sahiwal' UNION ALL
  SELECT 'Red Sindhi' UNION ALL
  SELECT 'Gir' UNION ALL
  SELECT 'Jersey × Friesian' UNION ALL
  SELECT 'Sahiwal crosses'
) b
WHERE c.name = 'Dairy';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN (
  SELECT 'Angus' AS name UNION ALL
  SELECT 'Hereford' UNION ALL
  SELECT 'Charolais' UNION ALL
  SELECT 'Simmental' UNION ALL
  SELECT 'Limousin' UNION ALL
  SELECT 'Brahman' UNION ALL
  SELECT 'Boran' UNION ALL
  SELECT 'Bonsmara' UNION ALL
  SELECT 'Nguni' UNION ALL
  SELECT 'Tuli' UNION ALL
  SELECT 'Afrikaner' UNION ALL
  SELECT 'Santa Gertrudis' UNION ALL
  SELECT 'Beefmaster'
) b
WHERE c.name = 'Beef';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN (
  SELECT 'Simmental (Fleckvieh)' AS name UNION ALL
  SELECT 'Shorthorn' UNION ALL
  SELECT 'Red Poll' UNION ALL
  SELECT 'Dexter' UNION ALL
  SELECT 'Normande' UNION ALL
  SELECT 'Angoni' UNION ALL
  SELECT 'Tonga' UNION ALL
  SELECT 'Barotse'
) b
WHERE c.name = 'Dual-Purpose';
