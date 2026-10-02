-- ===========================================================================
-- Reference data: Animal Category -> Production Purpose -> Breed / Strain.
-- Real reference data only - no livestock, inquiries or admins.
--
-- Cattle breeds come from the client's cattle breed reference document; the
-- other animals' breeds are common Zambian / Southern African breeds and
-- strains, and can be edited in Admin > Breeds.
--
-- `npm run db:setup` runs this only when the animals table is empty (a new
-- install, or the first upgrade to animal categories), so anything an admin
-- later deletes is not re-added. INSERT IGNORE makes it safe to run by hand.
-- ===========================================================================

INSERT IGNORE INTO animals (name, description, sort_order) VALUES
  ('Cattle', 'Dairy, beef and dual-purpose cattle.', 1),
  ('Goats', 'Meat, dairy and dual-purpose goats.', 2),
  ('Sheep', 'Meat, wool and dual-purpose sheep.', 3),
  ('Pigs', 'Meat and commercial pigs.', 4),
  ('Poultry', 'Layers, broilers, dual-purpose and breeding stock.', 5);

-- Cattle ----------------------------------------------------------------
INSERT IGNORE INTO categories (animal_id, name, description, sort_order)
SELECT a.id, p.name, p.description, p.sort_order FROM animals a
JOIN (
  SELECT 'Dairy' AS name, 'Breeds kept primarily for milk production.' AS description, 1 AS sort_order UNION ALL
  SELECT 'Beef', 'Breeds raised primarily for meat production.', 2 UNION ALL
  SELECT 'Dual-Purpose', 'Breeds suited to both milk and meat production.', 3
) p
WHERE a.name = 'Cattle';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
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
WHERE a.name = 'Cattle' AND c.name = 'Dairy';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
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
WHERE a.name = 'Cattle' AND c.name = 'Beef';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
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
WHERE a.name = 'Cattle' AND c.name = 'Dual-Purpose';

-- Goats -----------------------------------------------------------------
INSERT IGNORE INTO categories (animal_id, name, description, sort_order)
SELECT a.id, p.name, p.description, p.sort_order FROM animals a
JOIN (
  SELECT 'Meat' AS name, 'Goats raised primarily for meat.' AS description, 1 AS sort_order UNION ALL
  SELECT 'Dairy', 'Goats kept primarily for milk.', 2 UNION ALL
  SELECT 'Dual-Purpose', 'Goats suited to both milk and meat.', 3
) p
WHERE a.name = 'Goats';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Boer' AS name UNION ALL
  SELECT 'Kalahari Red' UNION ALL
  SELECT 'Savanna'
) b
WHERE a.name = 'Goats' AND c.name = 'Meat';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Saanen' AS name UNION ALL
  SELECT 'Toggenburg' UNION ALL
  SELECT 'British Alpine'
) b
WHERE a.name = 'Goats' AND c.name = 'Dairy';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Anglo-Nubian' AS name UNION ALL
  SELECT 'Boer × Local cross'
) b
WHERE a.name = 'Goats' AND c.name = 'Dual-Purpose';

-- Sheep -----------------------------------------------------------------
INSERT IGNORE INTO categories (animal_id, name, description, sort_order)
SELECT a.id, p.name, p.description, p.sort_order FROM animals a
JOIN (
  SELECT 'Meat' AS name, 'Sheep raised primarily for meat.' AS description, 1 AS sort_order UNION ALL
  SELECT 'Wool', 'Sheep kept primarily for wool.', 2 UNION ALL
  SELECT 'Dual-Purpose', 'Sheep suited to both meat and wool.', 3
) p
WHERE a.name = 'Sheep';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Dorper' AS name UNION ALL
  SELECT 'Damara' UNION ALL
  SELECT 'Van Rooy' UNION ALL
  SELECT 'Meatmaster' UNION ALL
  SELECT 'Blackhead Persian'
) b
WHERE a.name = 'Sheep' AND c.name = 'Meat';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Merino' AS name
) b
WHERE a.name = 'Sheep' AND c.name = 'Wool';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Dohne Merino' AS name UNION ALL
  SELECT 'SA Mutton Merino'
) b
WHERE a.name = 'Sheep' AND c.name = 'Dual-Purpose';

-- Pigs ------------------------------------------------------------------
INSERT IGNORE INTO categories (animal_id, name, description, sort_order)
SELECT a.id, p.name, p.description, p.sort_order FROM animals a
JOIN (
  SELECT 'Meat' AS name, 'Pig breeds raised for pork.' AS description, 1 AS sort_order UNION ALL
  SELECT 'Commercial', 'Crossbred lines for commercial pork production.', 2
) p
WHERE a.name = 'Pigs';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Large White' AS name UNION ALL
  SELECT 'Landrace' UNION ALL
  SELECT 'Duroc' UNION ALL
  SELECT 'Hampshire'
) b
WHERE a.name = 'Pigs' AND c.name = 'Meat';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Large White × Landrace' AS name UNION ALL
  SELECT 'Duroc terminal cross'
) b
WHERE a.name = 'Pigs' AND c.name = 'Commercial';

-- Poultry ---------------------------------------------------------------
INSERT IGNORE INTO categories (animal_id, name, description, sort_order)
SELECT a.id, p.name, p.description, p.sort_order FROM animals a
JOIN (
  SELECT 'Layers' AS name, 'Hens kept for egg production.' AS description, 1 AS sort_order UNION ALL
  SELECT 'Broilers', 'Fast-growing birds raised for meat.', 2 UNION ALL
  SELECT 'Dual-Purpose', 'Birds suited to both eggs and meat.', 3 UNION ALL
  SELECT 'Breeding', 'Parent stock for hatcheries and breeders.', 4
) p
WHERE a.name = 'Poultry';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Lohmann Brown' AS name UNION ALL
  SELECT 'ISA Brown' UNION ALL
  SELECT 'Hy-Line Brown'
) b
WHERE a.name = 'Poultry' AND c.name = 'Layers';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Cobb 500' AS name UNION ALL
  SELECT 'Ross 308' UNION ALL
  SELECT 'Arbor Acres'
) b
WHERE a.name = 'Poultry' AND c.name = 'Broilers';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Black Australorp' AS name UNION ALL
  SELECT 'Rhode Island Red' UNION ALL
  SELECT 'Sasso'
) b
WHERE a.name = 'Poultry' AND c.name = 'Dual-Purpose';

INSERT IGNORE INTO breeds (category_id, name)
SELECT c.id, b.name FROM categories c
JOIN animals a ON a.id = c.animal_id
JOIN (
  SELECT 'Layer parent stock' AS name UNION ALL
  SELECT 'Broiler parent stock'
) b
WHERE a.name = 'Poultry' AND c.name = 'Breeding';
