-- Feed types (kind = 'feed') with their stages, and Pets (livestock).
-- Run once by `npm run db:setup`: on a new install, or when an existing
-- database is upgraded to feed. Everything here is then managed in
-- Admin > Categories & Purposes, so it is never re-added after edits.
--
-- Feed types reuse the animals table (kind = 'feed') and their stages reuse
-- categories, so feed listings work exactly like livestock listings
-- (photos, price, Buy Now, orders).

INSERT IGNORE INTO animals (name, description, kind, sort_order) VALUES
  ('Pets', 'Dogs, cats, rabbits and other pets.', 'livestock', 6),
  ('Pig Feed', 'Starter, grower, finisher and breeding feeds for pigs.', 'feed', 101),
  ('Poultry Feed', 'Chick, broiler and layer feeds.', 'feed', 102),
  ('Dairy Feed', 'Calf, heifer and dairy cow rations.', 'feed', 103),
  ('Beef Feed', 'Creep, backgrounding and feedlot rations for beef cattle.', 'feed', 104),
  ('Fish Feed', 'Floating and sinking pellets for fry to table size.', 'feed', 105),
  ('Duck Feed', 'Duckling, grower and breeder feeds.', 'feed', 106),
  ('Goat Feed', 'Kid, grower and doe rations, licks and minerals.', 'feed', 107),
  ('Sheep Feed', 'Lamb, grower and ewe rations, licks and minerals.', 'feed', 108);

INSERT IGNORE INTO categories (animal_id, name, description, sort_order)
SELECT a.id, s.name, s.description, s.sort_order FROM animals a
JOIN (
  SELECT 'Pets' AS animal, 'Dogs' AS name, 'Puppies and adult dogs.' AS description, 1 AS sort_order
  UNION ALL SELECT 'Pets', 'Cats', 'Kittens and adult cats.', 2
  UNION ALL SELECT 'Pets', 'Rabbits', 'Pet and breeding rabbits.', 3
  UNION ALL SELECT 'Pets', 'Birds', 'Pet birds such as parrots and pigeons.', 4

  UNION ALL SELECT 'Pig Feed', 'Creep & Starter', 'For piglets before and just after weaning.', 1
  UNION ALL SELECT 'Pig Feed', 'Weaner', 'For weaned piglets.', 2
  UNION ALL SELECT 'Pig Feed', 'Grower', 'For growing pigs.', 3
  UNION ALL SELECT 'Pig Feed', 'Finisher', 'For pigs close to market weight.', 4
  UNION ALL SELECT 'Pig Feed', 'Sow & Lactation', 'For pregnant and nursing sows.', 5
  UNION ALL SELECT 'Pig Feed', 'Boar', 'For breeding boars.', 6

  UNION ALL SELECT 'Poultry Feed', 'Chick Mash', 'For day-old chicks.', 1
  UNION ALL SELECT 'Poultry Feed', 'Broiler Starter', 'For broilers in the first weeks.', 2
  UNION ALL SELECT 'Poultry Feed', 'Broiler Grower', 'For growing broilers.', 3
  UNION ALL SELECT 'Poultry Feed', 'Broiler Finisher', 'For broilers before sale.', 4
  UNION ALL SELECT 'Poultry Feed', 'Growers Mash', 'For pullets before laying.', 5
  UNION ALL SELECT 'Poultry Feed', 'Layers Mash', 'For laying hens.', 6

  UNION ALL SELECT 'Dairy Feed', 'Calf Starter', 'For young calves.', 1
  UNION ALL SELECT 'Dairy Feed', 'Heifer Ration', 'For growing heifers.', 2
  UNION ALL SELECT 'Dairy Feed', 'Dairy Meal', 'For milking cows.', 3
  UNION ALL SELECT 'Dairy Feed', 'Dry Cow', 'For cows between lactations.', 4

  UNION ALL SELECT 'Beef Feed', 'Calf Creep', 'For calves still with their mothers.', 1
  UNION ALL SELECT 'Beef Feed', 'Backgrounding', 'For weaned calves and growing cattle.', 2
  UNION ALL SELECT 'Beef Feed', 'Feedlot Finisher', 'For cattle being finished for sale.', 3
  UNION ALL SELECT 'Beef Feed', 'Licks & Minerals', 'Supplements for cattle on grazing.', 4

  UNION ALL SELECT 'Fish Feed', 'Fry Starter', 'For newly hatched fry.', 1
  UNION ALL SELECT 'Fish Feed', 'Fingerling', 'For fingerlings.', 2
  UNION ALL SELECT 'Fish Feed', 'Grower Pellets', 'For growing fish.', 3
  UNION ALL SELECT 'Fish Feed', 'Finisher Pellets', 'For fish close to table size.', 4

  UNION ALL SELECT 'Duck Feed', 'Duckling Starter', 'For young ducklings.', 1
  UNION ALL SELECT 'Duck Feed', 'Duck Grower', 'For growing ducks.', 2
  UNION ALL SELECT 'Duck Feed', 'Layer & Breeder', 'For laying and breeding ducks.', 3

  UNION ALL SELECT 'Goat Feed', 'Kid Starter', 'For young kids.', 1
  UNION ALL SELECT 'Goat Feed', 'Goat Pellets', 'For growing goats.', 2
  UNION ALL SELECT 'Goat Feed', 'Lactating Doe', 'For milking does.', 3
  UNION ALL SELECT 'Goat Feed', 'Licks & Minerals', 'Supplements for goats.', 4

  UNION ALL SELECT 'Sheep Feed', 'Lamb Creep', 'For young lambs.', 1
  UNION ALL SELECT 'Sheep Feed', 'Sheep Pellets', 'For growing sheep.', 2
  UNION ALL SELECT 'Sheep Feed', 'Ewe Ration', 'For pregnant and nursing ewes.', 3
  UNION ALL SELECT 'Sheep Feed', 'Licks & Minerals', 'Supplements for sheep.', 4
) s ON s.animal = a.name;
