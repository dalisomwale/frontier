-- ===========================================================================
-- Frontier Marketplace - database schema (v2: admin-managed inquiry platform)
-- ===========================================================================
-- Prefer `npm run db:setup`, which runs this file against DB_NAME from .env,
-- archives any v1 tables first, migrates older v2 databases and seeds the
-- animal / production purpose / breed reference list.
--
-- Running it by hand also works:
--   mysql -u <user> -p <database> < database/schema.sql
--   mysql -u <user> -p <database> < database/seed-taxonomy.sql
--
-- Every statement is idempotent (CREATE TABLE IF NOT EXISTS).
-- Compatible with MySQL 8.0+ and MariaDB 10.5+.
-- ===========================================================================

-- admins: the only accounts on the platform ---------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(120) NOT NULL,
  email          VARCHAR(255) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  last_login_at  DATETIME NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Taxonomy: Animal Category -> Production Purpose -> Breed
--   animals     Cattle, Goats, Sheep, Pigs, Poultry
--   categories  production purposes, each belonging to one animal
--               (Cattle: Dairy, Beef, Dual-Purpose; Goats: Meat, Dairy, ...)
--   breeds      each belonging to one production purpose

-- animals: the animal categories ---------------------------------------------
CREATE TABLE IF NOT EXISTS animals (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  description  TEXT NULL,
  image_path   VARCHAR(500) NULL,
  kind         ENUM('livestock', 'feed') NOT NULL DEFAULT 'livestock',
  status       ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_animals_name (name),
  INDEX idx_animals_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- categories: production purposes; names are unique per animal (both Cattle
-- and Goats have "Dairy") ----------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  animal_id    INT UNSIGNED NOT NULL,
  name         VARCHAR(100) NOT NULL,
  description  TEXT NULL,
  image_path   VARCHAR(500) NULL,
  status       ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_categories_animal FOREIGN KEY (animal_id)
    REFERENCES animals(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE KEY uniq_categories_animal_name (animal_id, name),
  INDEX idx_categories_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- breeds: each belongs to exactly one production purpose --------------------
CREATE TABLE IF NOT EXISTS breeds (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category_id  INT UNSIGNED NOT NULL,
  name         VARCHAR(120) NOT NULL,
  description  TEXT NULL,
  status       ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_breeds_category FOREIGN KEY (category_id)
    REFERENCES categories(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE KEY uniq_breeds_category_name (category_id, name),
  INDEX idx_breeds_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- category_images: photos for a production purpose. The website slides
-- through them on the purpose's tile (first = shown first). -----------------
CREATE TABLE IF NOT EXISTS category_images (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category_id  INT UNSIGNED NOT NULL,
  image_path   VARCHAR(500) NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_category_images_category FOREIGN KEY (category_id)
    REFERENCES categories(id) ON DELETE CASCADE,
  INDEX idx_category_images (category_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- sellers: the farmers and suppliers whose livestock Frontier lists. Admin
-- only - visitors never see sellers; every inquiry comes to Frontier, which
-- then knows from the listing which seller it is for.
CREATE TABLE IF NOT EXISTS sellers (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(120) NOT NULL,
  business_name  VARCHAR(150) NULL,
  phone          VARCHAR(30) NOT NULL,
  email          VARCHAR(255) NULL,
  province       VARCHAR(50) NULL,
  address        VARCHAR(255) NULL,
  pickup_district VARCHAR(80) NULL,
  pickup_address VARCHAR(255) NULL,
  pickup_lat     DECIMAL(9,6) NULL,
  pickup_lng     DECIMAL(9,6) NULL,
  notes          TEXT NULL,
  status         ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  password_hash  VARCHAR(255) NULL,
  account_status ENUM('pending', 'approved', 'rejected') NULL,
  account_note   VARCHAR(500) NULL,
  approved_at    DATETIME NULL,
  last_login_at  DATETIME NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sellers_name (name),
  INDEX idx_sellers_status (status),
  INDEX idx_sellers_email (email),
  INDEX idx_sellers_account (account_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS seller_password_resets (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  seller_id   INT UNSIGNED NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_seller_password_resets_seller FOREIGN KEY (seller_id)
    REFERENCES sellers(id) ON DELETE CASCADE,
  UNIQUE KEY uq_resets_token (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- livestock: listings, created by administrators only. category_id is the
-- production purpose (which implies the animal); livestock_type is the
-- animal-specific type (Bull, Doe, Ewe, Sow, Hen...) shown on the listing.
CREATE TABLE IF NOT EXISTS livestock (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title           VARCHAR(200) NOT NULL,
  category_id     INT UNSIGNED NOT NULL,
  breed_id        INT UNSIGNED NULL,
  livestock_type  VARCHAR(40) NULL,
  quantity        INT UNSIGNED NOT NULL DEFAULT 1,
  price           DECIMAL(12,2) NULL,
  price_unit      ENUM('head', 'lot') NOT NULL DEFAULT 'head',
  price_negotiable TINYINT(1) NOT NULL DEFAULT 0,
  age_months      SMALLINT UNSIGNED NULL,
  location        VARCHAR(150) NOT NULL,
  description     TEXT NULL,
  status          ENUM('published', 'unpublished') NOT NULL DEFAULT 'unpublished',
  published_at    DATETIME NULL,
  went_live_at    DATETIME NULL, -- first time it was published; never cleared
  verification    ENUM('unverified', 'verified') NOT NULL DEFAULT 'unverified',
  seller_id       INT UNSIGNED NULL,
  review_status   ENUM('approved', 'pending', 'rejected') NOT NULL DEFAULT 'approved',
  review_note     VARCHAR(500) NULL,
  submitted_at    DATETIME NULL,
  created_by      INT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_livestock_category FOREIGN KEY (category_id)
    REFERENCES categories(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_livestock_breed FOREIGN KEY (breed_id)
    REFERENCES breeds(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_livestock_admin FOREIGN KEY (created_by)
    REFERENCES admins(id) ON DELETE SET NULL,
  CONSTRAINT fk_livestock_seller FOREIGN KEY (seller_id)
    REFERENCES sellers(id) ON DELETE SET NULL,
  INDEX idx_livestock_seller (seller_id),
  INDEX idx_livestock_public (status, category_id, breed_id),
  INDEX idx_livestock_review (review_status),
  INDEX idx_livestock_location (location),
  INDEX idx_livestock_type (livestock_type),
  INDEX idx_livestock_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- livestock_images: each upload is stored as an optimised large WebP plus a
-- small card thumbnail ------------------------------------------------------
CREATE TABLE IF NOT EXISTS livestock_images (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  livestock_id  INT UNSIGNED NOT NULL,
  image_path    VARCHAR(500) NOT NULL,
  thumb_path    VARCHAR(500) NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_images_livestock FOREIGN KEY (livestock_id)
    REFERENCES livestock(id) ON DELETE CASCADE,
  INDEX idx_images_livestock (livestock_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- inquiries: submitted by visitors, no account needed -----------------------
-- Title/category/breed are copied at submission so an inquiry stays readable
-- even if the listing is later edited or deleted.
CREATE TABLE IF NOT EXISTS inquiries (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  livestock_id     INT UNSIGNED NULL,
  livestock_title  VARCHAR(200) NOT NULL,
  animal_name      VARCHAR(100) NULL,
  category_name    VARCHAR(100) NULL,
  breed_name       VARCHAR(120) NULL,
  seller_id        INT UNSIGNED NULL,
  seller_name      VARCHAR(150) NULL,
  forwarded_at     DATETIME NULL,
  forward_message  TEXT NULL,
  seller_reply     TEXT NULL,
  seller_replied_at DATETIME NULL,
  seller_seen_at   DATETIME NULL,
  full_name        VARCHAR(120) NOT NULL,
  phone            VARCHAR(30) NOT NULL,
  email            VARCHAR(255) NOT NULL,
  message          TEXT NOT NULL,
  status           ENUM('new', 'contacted', 'in_progress', 'resolved') NOT NULL DEFAULT 'new',
  is_archived      TINYINT(1) NOT NULL DEFAULT 0,
  email_status     ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
  email_error      VARCHAR(500) NULL,
  ip_address       VARCHAR(45) NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_inquiries_livestock FOREIGN KEY (livestock_id)
    REFERENCES livestock(id) ON DELETE SET NULL,
  CONSTRAINT fk_inquiries_seller_ref FOREIGN KEY (seller_id)
    REFERENCES sellers(id) ON DELETE SET NULL,
  INDEX idx_inquiries_seller (seller_id),
  INDEX idx_inquiries_status (is_archived, status, created_at),
  INDEX idx_inquiries_livestock (livestock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- admin_sessions: server-side admin login sessions (express-mysql-session).
-- The app also creates this on startup; defining it here means a freshly
-- set-up database always has it.
CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id  VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  expires     INT UNSIGNED NOT NULL,
  data        MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB;

-- seller_sessions: signed-in seller accounts, kept apart from admin sessions.
CREATE TABLE IF NOT EXISTS seller_sessions (
  session_id  VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  expires     INT UNSIGNED NOT NULL,
  data        MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB;

-- seller_notifications: in-app notices for seller accounts (account
-- approved, listing approved or sent back, new message from Frontier).
CREATE TABLE IF NOT EXISTS seller_notifications (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  seller_id   INT UNSIGNED NOT NULL,
  type        VARCHAR(40) NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        VARCHAR(1000) NULL,
  link        VARCHAR(255) NULL,
  read_at     DATETIME NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_seller_notifications_seller FOREIGN KEY (seller_id)
    REFERENCES sellers(id) ON DELETE CASCADE,
  INDEX idx_seller_notifications (seller_id, read_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- inquiry_messages: the conversation on an inquiry. Frontier's replies go to
-- the customer by email and to the seller (dashboard and email); sellers
-- reply to Frontier only. Sellers never see the customer's details.
CREATE TABLE IF NOT EXISTS inquiry_messages (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  inquiry_id       INT UNSIGNED NOT NULL,
  sender           ENUM('admin', 'seller') NOT NULL,
  body             TEXT NOT NULL,
  to_customer      TINYINT(1) NOT NULL DEFAULT 0,
  to_seller        TINYINT(1) NOT NULL DEFAULT 0,
  customer_emailed TINYINT(1) NOT NULL DEFAULT 0,
  seller_emailed   TINYINT(1) NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_inquiry_messages_inquiry FOREIGN KEY (inquiry_id)
    REFERENCES inquiries(id) ON DELETE CASCADE,
  INDEX idx_inquiry_messages (inquiry_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- orders: "Buy Now" requests from visitors. Nothing is paid on the website:
-- the team confirms availability with the seller, then sends the buyer
-- payment details. Listing details and price are copied at the time of the
-- order so it stays readable if the listing changes later.
CREATE TABLE IF NOT EXISTS orders (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  livestock_id     INT UNSIGNED NULL,
  livestock_title  VARCHAR(200) NOT NULL,
  seller_id        INT UNSIGNED NULL,
  seller_name      VARCHAR(150) NULL,
  quantity         INT UNSIGNED NOT NULL,
  unit_price       DECIMAL(12,2) NOT NULL,
  price_unit       ENUM('head', 'lot') NOT NULL DEFAULT 'head',
  total            DECIMAL(14,2) NOT NULL,
  full_name        VARCHAR(120) NOT NULL,
  phone            VARCHAR(30) NOT NULL,
  email            VARCHAR(255) NOT NULL,
  delivery         ENUM('collect', 'deliver') NOT NULL DEFAULT 'collect',
  delivery_address VARCHAR(300) NULL,
  payment_method   ENUM('mobile_money', 'bank_transfer', 'card') NOT NULL DEFAULT 'mobile_money',
  mobile_operator  ENUM('airtel', 'mtn', 'zamtel') NULL,
  payment_phone    VARCHAR(30) NULL,
  payment_bank     VARCHAR(80) NULL,
  payment_account  VARCHAR(30) NULL,
  card_brand       VARCHAR(20) NULL,
  card_last4       CHAR(4) NULL,
  payment_status   ENUM('unpaid', 'pending', 'paid', 'failed') NOT NULL DEFAULT 'unpaid',
  payment_reference VARCHAR(64) NULL,
  payment_provider_ref VARCHAR(80) NULL,
  payment_failure  VARCHAR(255) NULL,
  payment_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  payment_checked_at DATETIME NULL,
  paid_at          DATETIME NULL,
  public_token     CHAR(32) NULL,
  payment_reminder_at DATETIME NULL,
  checkout_id      INT UNSIGNED NULL,
  status           ENUM('new', 'confirmed', 'paid', 'completed', 'cancelled') NOT NULL DEFAULT 'new',
  stock_deducted   TINYINT(1) NOT NULL DEFAULT 0,
  hold_until       DATETIME NULL,
  seller_notified_at DATETIME NULL,
  buyer_id         INT UNSIGNED NULL,
  handover_method  ENUM('collected', 'delivered') NULL,
  handed_over_at   DATETIME NULL,
  handed_over_by   VARCHAR(150) NULL,
  received_at      DATETIME NULL,
  received_note    VARCHAR(500) NULL,
  sent_method      ENUM('collected', 'delivered') NULL,
  sent_at          DATETIME NULL,
  sent_by          VARCHAR(150) NULL,
  sent_note        VARCHAR(500) NULL,
  seller_paid_at   DATETIME NULL,
  seller_paid_by   VARCHAR(150) NULL,
  seller_paid_ref  VARCHAR(150) NULL,
  transport_booking_id INT UNSIGNED NULL,
  email_status     ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
  email_error      VARCHAR(500) NULL,
  ip_address       VARCHAR(45) NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_livestock FOREIGN KEY (livestock_id)
    REFERENCES livestock(id) ON DELETE SET NULL,
  CONSTRAINT fk_orders_seller FOREIGN KEY (seller_id)
    REFERENCES sellers(id) ON DELETE SET NULL,
  INDEX idx_orders_status (status, created_at),
  INDEX idx_orders_livestock (livestock_id),
  INDEX idx_orders_seller (seller_id),
  INDEX idx_orders_checkout (checkout_id),
  INDEX idx_orders_buyer (buyer_id),
  INDEX idx_orders_payment_ref (payment_reference),
  INDEX idx_orders_transport (transport_booking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A shopping-cart checkout. The buyer pays once for the whole cart; each
-- item in it becomes its own order (orders.checkout_id), so every seller
-- still sees only their part. Payment is by mobile money only.
CREATE TABLE IF NOT EXISTS checkouts (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_token        CHAR(32) NOT NULL,
  buyer_id            INT UNSIGNED NULL,
  full_name           VARCHAR(120) NOT NULL,
  phone               VARCHAR(30) NOT NULL,
  email               VARCHAR(255) NOT NULL,
  item_count          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  total               DECIMAL(14,2) NOT NULL,
  delivery_option     ENUM('collect', 'transport') NOT NULL DEFAULT 'collect',
  transport_total     DECIMAL(12,2) NOT NULL DEFAULT 0,
  mobile_operator     ENUM('airtel', 'mtn', 'zamtel') NULL,
  payment_phone       VARCHAR(30) NULL,
  payment_status      ENUM('unpaid', 'pending', 'paid', 'failed') NOT NULL DEFAULT 'unpaid',
  payment_method      ENUM('mobile_money', 'card', 'bank_transfer') NOT NULL DEFAULT 'mobile_money',
  payment_provider    VARCHAR(20) NULL,
  payment_url         VARCHAR(500) NULL,
  payment_reference   VARCHAR(64) NULL,
  payment_provider_ref VARCHAR(80) NULL,
  payment_failure     VARCHAR(255) NULL,
  payment_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  payment_checked_at  DATETIME NULL,
  payment_started_at  DATETIME NULL,
  payment_alert_at    DATETIME NULL,
  payment_check_error VARCHAR(255) NULL,
  failure_emailed_ref VARCHAR(40) NULL,
  terms_accepted_at   DATETIME NULL,
  paid_at             DATETIME NULL,
  payment_reminder_at DATETIME NULL,
  ip_address          VARCHAR(45) NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_checkouts_payment_ref (payment_reference),
  INDEX idx_checkouts_buyer (buyer_id),
  INDEX idx_checkouts_status (payment_status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Buyer accounts. A buyer needs an account to check out; their orders,
-- handovers and confirmations are on their account pages (/account/).
CREATE TABLE IF NOT EXISTS buyers (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name          VARCHAR(120) NOT NULL,
  email              VARCHAR(255) NOT NULL,
  phone              VARCHAR(30) NOT NULL,
  password_hash      VARCHAR(255) NOT NULL,
  status             ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  email_verified_at  DATETIME NULL,
  last_login_at      DATETIME NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_buyers_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time links for buyers: password reset and email confirmation.
CREATE TABLE IF NOT EXISTS buyer_tokens (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  buyer_id    INT UNSIGNED NOT NULL,
  purpose     ENUM('reset', 'verify') NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_buyer_tokens_buyer FOREIGN KEY (buyer_id)
    REFERENCES buyers(id) ON DELETE CASCADE,
  UNIQUE KEY uq_buyer_tokens (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS buyer_notifications (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  buyer_id    INT UNSIGNED NOT NULL,
  type        VARCHAR(40) NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        VARCHAR(1000) NULL,
  link        VARCHAR(255) NULL,
  read_at     DATETIME NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_buyer_notifications_buyer FOREIGN KEY (buyer_id)
    REFERENCES buyers(id) ON DELETE CASCADE,
  INDEX idx_buyer_notifications (buyer_id, read_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Photos of an order changing hands: the seller's (when they deliver or the
-- buyer collects) and the buyer's (when they confirm they've received it).
CREATE TABLE IF NOT EXISTS order_receipt_photos (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id    INT UNSIGNED NOT NULL,
  party       ENUM('buyer', 'seller', 'payout') NOT NULL DEFAULT 'buyer',
  image_path  VARCHAR(255) NOT NULL,
  thumb_path  VARCHAR(255) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_receipt_photos_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  INDEX idx_receipt_photos_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Small key/value store for background jobs (e.g. the day the morning
-- summary was last sent), so a restart doesn't send it twice.
CREATE TABLE IF NOT EXISTS app_state (
  name       VARCHAR(64) PRIMARY KEY,
  value      VARCHAR(255) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Transaction audit trail: every step of every payment, in order. Rows are
-- only ever added (never changed or deleted by the website).
CREATE TABLE IF NOT EXISTS transaction_events (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  checkout_id  INT UNSIGNED NOT NULL,
  order_id     INT UNSIGNED NULL,
  reference    VARCHAR(40) NULL,
  event        VARCHAR(40) NOT NULL,
  status       VARCHAR(20) NULL,
  amount       DECIMAL(12,2) NULL,
  actor        VARCHAR(20) NOT NULL DEFAULT 'website',
  admin_id     INT UNSIGNED NULL,
  admin_name   VARCHAR(120) NULL,
  detail       VARCHAR(500) NOT NULL DEFAULT '',
  data         TEXT NULL,
  ip_address   VARCHAR(45) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tx_checkout (checkout_id, id),
  KEY idx_tx_created (created_at),
  KEY idx_tx_reference (reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Transport: delivery of paid orders by approved transport providers.
-- The provider is the driver/operator (there are no separate driver accounts).
-- Frontier sets each provider's coverage and the distance-based prices; the
-- provider never sets either.
-- ===========================================================================

-- transport_providers: individuals or companies who carry the goods. They
-- register, Frontier approves them and sets how far they cover.
CREATE TABLE IF NOT EXISTS transport_providers (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind                ENUM('individual', 'company') NOT NULL DEFAULT 'individual',
  name                VARCHAR(150) NOT NULL,
  contact_person      VARCHAR(120) NULL,
  phone               VARCHAR(30) NOT NULL,
  email               VARCHAR(255) NOT NULL,
  province            VARCHAR(50) NOT NULL,
  district            VARCHAR(80) NOT NULL,
  address             VARCHAR(255) NOT NULL,
  base_label          VARCHAR(255) NULL,
  base_lat            DECIMAL(9,6) NULL,
  base_lng            DECIMAL(9,6) NULL,
  registration_number VARCHAR(80) NULL,
  licence_number      VARCHAR(80) NULL,
  password_hash       VARCHAR(255) NOT NULL,
  status              ENUM('pending', 'approved', 'rejected', 'suspended') NOT NULL DEFAULT 'pending',
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  is_available        TINYINT(1) NOT NULL DEFAULT 1,
  coverage_km         DECIMAL(7,1) NULL,
  coverage_active     TINYINT(1) NOT NULL DEFAULT 0,
  preferred_coverage_km DECIMAL(7,1) NULL,
  preferred_coverage_at DATETIME NULL,
  admin_note          VARCHAR(500) NULL,
  approved_at         DATETIME NULL,
  last_login_at       DATETIME NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_transport_providers_email (email),
  INDEX idx_transport_providers_match (status, is_active, coverage_active, is_available)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Licences, permits and registration papers. Kept outside the public folder
-- (storage/transport) and served only to the provider and admins.
CREATE TABLE IF NOT EXISTS transport_provider_documents (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id    INT UNSIGNED NOT NULL,
  doc_type       VARCHAR(40) NOT NULL,
  file_name      VARCHAR(255) NOT NULL,
  original_name  VARCHAR(255) NULL,
  mime           VARCHAR(80) NOT NULL,
  size_bytes     INT UNSIGNED NOT NULL DEFAULT 0,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tp_documents_provider FOREIGN KEY (provider_id)
    REFERENCES transport_providers(id) ON DELETE CASCADE,
  INDEX idx_tp_documents (provider_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transport_provider_sessions (
  session_id  VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  expires     INT UNSIGNED NOT NULL,
  data        MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS transport_provider_resets (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id  INT UNSIGNED NOT NULL,
  token_hash   CHAR(64) NOT NULL,
  expires_at   DATETIME NOT NULL,
  used_at      DATETIME NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tp_resets_provider FOREIGN KEY (provider_id)
    REFERENCES transport_providers(id) ON DELETE CASCADE,
  UNIQUE KEY uq_tp_resets_token (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transport_provider_notifications (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id  INT UNSIGNED NOT NULL,
  type         VARCHAR(40) NOT NULL,
  title        VARCHAR(200) NOT NULL,
  body         VARCHAR(1000) NULL,
  link         VARCHAR(255) NULL,
  read_at      DATETIME NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tp_notifications_provider FOREIGN KEY (provider_id)
    REFERENCES transport_providers(id) ON DELETE CASCADE,
  INDEX idx_tp_notifications (provider_id, read_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vehicles a provider has registered. What each one can carry is listed in
-- transport_vehicle_cargo: an animal category (cargo_key 'a<animal id>') or
-- feed ('feed'), with the most it can carry at once.
CREATE TABLE IF NOT EXISTS transport_vehicles (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id    INT UNSIGNED NOT NULL,
  registration   VARCHAR(30) NOT NULL,
  vehicle_type   VARCHAR(60) NOT NULL,
  capacity_note  VARCHAR(255) NULL,
  status         ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tv_provider FOREIGN KEY (provider_id)
    REFERENCES transport_providers(id) ON DELETE CASCADE,
  UNIQUE KEY uq_tv_registration (registration),
  INDEX idx_tv_provider (provider_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transport_vehicle_cargo (
  vehicle_id    INT UNSIGNED NOT NULL,
  cargo_key     VARCHAR(20) NOT NULL,
  max_quantity  INT UNSIGNED NOT NULL,
  PRIMARY KEY (vehicle_id, cargo_key),
  CONSTRAINT fk_tvc_vehicle FOREIGN KEY (vehicle_id)
    REFERENCES transport_vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vehicle photos (public uploads) and papers (private, file_name only).
CREATE TABLE IF NOT EXISTS transport_vehicle_files (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  vehicle_id     INT UNSIGNED NOT NULL,
  kind           ENUM('photo', 'document') NOT NULL,
  image_path     VARCHAR(255) NULL,
  thumb_path     VARCHAR(255) NULL,
  file_name      VARCHAR(255) NULL,
  original_name  VARCHAR(255) NULL,
  mime           VARCHAR(80) NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tvf_vehicle FOREIGN KEY (vehicle_id)
    REFERENCES transport_vehicles(id) ON DELETE CASCADE,
  INDEX idx_tvf_vehicle (vehicle_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Distance-based prices set by Frontier. A journey of d km uses the active
-- band with min_km <= d < max_km (max_km NULL = no upper limit):
-- fee = base_fee + per_km * d.
CREATE TABLE IF NOT EXISTS transport_price_bands (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  min_km      DECIMAL(7,1) NOT NULL,
  max_km      DECIMAL(7,1) NULL,
  base_fee    DECIMAL(12,2) NOT NULL,
  per_km      DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tpb_active (is_active, min_km)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Transport settings (Frontier's own pickup point, how long providers have
-- to accept, commission ...). Small key/value list, edited in the admin.
CREATE TABLE IF NOT EXISTS transport_settings (
  name        VARCHAR(64) PRIMARY KEY,
  value       TEXT NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One transport booking per pickup point (seller) in a checkout. The road
-- distance, the price band used and the fee are stored when the buyer checks
-- out and never change afterwards. Status changes are checked by the server
-- (server/lib/transport) and every change is written to transport_events.
CREATE TABLE IF NOT EXISTS transport_bookings (
  id                       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  checkout_id              INT UNSIGNED NOT NULL,
  buyer_id                 INT UNSIGNED NULL,
  seller_id                INT UNSIGNED NULL,
  pickup_label             VARCHAR(150) NOT NULL,
  pickup_address           VARCHAR(255) NULL,
  pickup_district          VARCHAR(80) NULL,
  pickup_province          VARCHAR(50) NULL,
  pickup_phone             VARCHAR(30) NULL,
  pickup_lat               DECIMAL(9,6) NOT NULL,
  pickup_lng               DECIMAL(9,6) NOT NULL,
  dest_province            VARCHAR(50) NOT NULL,
  dest_district            VARCHAR(80) NOT NULL,
  dest_address             VARCHAR(255) NOT NULL,
  dest_notes               VARCHAR(255) NULL,
  dest_lat                 DECIMAL(9,6) NOT NULL,
  dest_lng                 DECIMAL(9,6) NOT NULL,
  contact_name             VARCHAR(120) NOT NULL,
  contact_phone            VARCHAR(30) NOT NULL,
  distance_km              DECIMAL(8,2) NOT NULL,
  duration_min             INT UNSIGNED NULL,
  route_geometry           MEDIUMTEXT NULL,
  routing_provider         VARCHAR(20) NOT NULL,
  band_id                  INT UNSIGNED NULL,
  band_min_km              DECIMAL(7,1) NOT NULL,
  band_max_km              DECIMAL(7,1) NULL,
  base_fee                 DECIMAL(12,2) NOT NULL,
  per_km                   DECIMAL(10,2) NOT NULL DEFAULT 0,
  fee                      DECIMAL(12,2) NOT NULL,
  commission_pct           DECIMAL(5,2) NOT NULL DEFAULT 0,
  platform_commission      DECIMAL(12,2) NOT NULL DEFAULT 0,
  provider_earning         DECIMAL(12,2) NOT NULL DEFAULT 0,
  cargo_summary            VARCHAR(500) NULL,
  status                   VARCHAR(30) NOT NULL DEFAULT 'pending_payment',
  provider_id              INT UNSIGNED NULL,
  vehicle_id               INT UNSIGNED NULL,
  paid_at                  DATETIME NULL,
  offers_sent_at           DATETIME NULL,
  accepted_at              DATETIME NULL,
  seller_ready_at          DATETIME NULL,
  collection_confirmed_at  DATETIME NULL,
  started_at               DATETIME NULL,
  arrived_at               DATETIME NULL,
  delivery_submitted_at    DATETIME NULL,
  completed_at             DATETIME NULL,
  disputed_at              DATETIME NULL,
  cancelled_at             DATETIME NULL,
  cancel_reason            VARCHAR(500) NULL,
  refunded_at              DATETIME NULL,
  refund_ref               VARCHAR(150) NULL,
  unaccepted_alert_at      DATETIME NULL,
  delay_alert_at           DATETIME NULL,
  last_lat                 DECIMAL(9,6) NULL,
  last_lng                 DECIMAL(9,6) NULL,
  last_location_at         DATETIME NULL,
  provider_paid_at         DATETIME NULL,
  provider_paid_ref        VARCHAR(150) NULL,
  provider_paid_by         VARCHAR(150) NULL,
  vehicle_registration     VARCHAR(30) NULL,
  vehicle_type             VARCHAR(60) NULL,
  on_hold                  TINYINT(1) NOT NULL DEFAULT 0,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tb_provider FOREIGN KEY (provider_id)
    REFERENCES transport_providers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tb_vehicle FOREIGN KEY (vehicle_id)
    REFERENCES transport_vehicles(id) ON DELETE RESTRICT,
  INDEX idx_tb_checkout (checkout_id),
  INDEX idx_tb_status (status, created_at),
  INDEX idx_tb_provider (provider_id, status),
  INDEX idx_tb_vehicle (vehicle_id, status),
  INDEX idx_tb_seller (seller_id),
  INDEX idx_tb_buyer (buyer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which orders each booking carries. An order is in at most one booking.
CREATE TABLE IF NOT EXISTS transport_booking_orders (
  booking_id  INT UNSIGNED NOT NULL,
  order_id    INT UNSIGNED NOT NULL,
  PRIMARY KEY (booking_id, order_id),
  UNIQUE KEY uq_tbo_order (order_id),
  CONSTRAINT fk_tbo_booking FOREIGN KEY (booking_id)
    REFERENCES transport_bookings(id) ON DELETE CASCADE,
  CONSTRAINT fk_tbo_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Requests sent to eligible providers, and their answers.
CREATE TABLE IF NOT EXISTS transport_offers (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id    INT UNSIGNED NOT NULL,
  provider_id   INT UNSIGNED NOT NULL,
  status        ENUM('offered', 'declined', 'accepted', 'withdrawn') NOT NULL DEFAULT 'offered',
  reason        VARCHAR(255) NULL,
  pickup_km     DECIMAL(8,2) NULL,
  dest_km       DECIMAL(8,2) NULL,
  offered_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at  DATETIME NULL,
  CONSTRAINT fk_to_booking FOREIGN KEY (booking_id)
    REFERENCES transport_bookings(id) ON DELETE CASCADE,
  CONSTRAINT fk_to_provider FOREIGN KEY (provider_id)
    REFERENCES transport_providers(id) ON DELETE CASCADE,
  UNIQUE KEY uq_to_booking_provider (booking_id, provider_id),
  INDEX idx_to_provider (provider_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quantities recorded at each step, per order: what the seller released,
-- what the provider collected and what the provider delivered.
CREATE TABLE IF NOT EXISTS transport_quantities (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id  INT UNSIGNED NOT NULL,
  order_id    INT UNSIGNED NOT NULL,
  stage       ENUM('seller_release', 'provider_collected', 'provider_delivered') NOT NULL,
  quantity    INT UNSIGNED NOT NULL,
  id_details  VARCHAR(500) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tq_booking FOREIGN KEY (booking_id)
    REFERENCES transport_bookings(id) ON DELETE CASCADE,
  UNIQUE KEY uq_tq_step (booking_id, order_id, stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each party's record of a step (one per party and step; never replaced).
CREATE TABLE IF NOT EXISTS transport_submissions (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id   INT UNSIGNED NOT NULL,
  stage        ENUM('seller_collection', 'provider_collection', 'provider_delivery', 'customer_delivery') NOT NULL,
  party        ENUM('seller', 'provider', 'customer', 'admin') NOT NULL,
  actor_name   VARCHAR(150) NULL,
  note         VARCHAR(1000) NULL,
  discrepancy  TINYINT(1) NOT NULL DEFAULT 0,
  lat          DECIMAL(9,6) NULL,
  lng          DECIMAL(9,6) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ts_booking FOREIGN KEY (booking_id)
    REFERENCES transport_bookings(id) ON DELETE CASCADE,
  UNIQUE KEY uq_ts_step (booking_id, stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Photos taken at collection and delivery. Each party's photos are kept
-- separately and are only ever added, never replaced.
CREATE TABLE IF NOT EXISTS transport_photos (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id  INT UNSIGNED NOT NULL,
  stage       ENUM('seller_collection', 'provider_collection', 'provider_delivery', 'customer_delivery') NOT NULL,
  party       ENUM('seller', 'provider', 'customer', 'admin') NOT NULL,
  image_path  VARCHAR(255) NOT NULL,
  thumb_path  VARCHAR(255) NOT NULL,
  lat         DECIMAL(9,6) NULL,
  lng         DECIMAL(9,6) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tph_booking FOREIGN KEY (booking_id)
    REFERENCES transport_bookings(id) ON DELETE CASCADE,
  INDEX idx_tph_booking (booking_id, stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A problem the buyer reports at delivery. Frontier investigates and resolves it.
CREATE TABLE IF NOT EXISTS transport_disputes (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id       INT UNSIGNED NOT NULL,
  buyer_id         INT UNSIGNED NULL,
  reason           ENUM('missing', 'quantity', 'damaged', 'condition', 'other') NOT NULL,
  description      VARCHAR(2000) NOT NULL,
  status           ENUM('open', 'resolved') NOT NULL DEFAULT 'open',
  resolution       ENUM('completed', 'refund') NULL,
  resolution_note  VARCHAR(1000) NULL,
  resolved_by      VARCHAR(150) NULL,
  resolved_at      DATETIME NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_td_booking FOREIGN KEY (booking_id)
    REFERENCES transport_bookings(id) ON DELETE CASCADE,
  INDEX idx_td_booking (booking_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Full history of every booking: each status change and action, in order.
CREATE TABLE IF NOT EXISTS transport_events (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id   INT UNSIGNED NOT NULL,
  from_status  VARCHAR(30) NULL,
  to_status    VARCHAR(30) NULL,
  event        VARCHAR(40) NOT NULL,
  actor        ENUM('system', 'customer', 'seller', 'provider', 'admin') NOT NULL DEFAULT 'system',
  actor_name   VARCHAR(150) NULL,
  detail       VARCHAR(1000) NOT NULL DEFAULT '',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_te_booking (booking_id, id),
  INDEX idx_te_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- GPS positions sent by the provider's phone while delivering.
CREATE TABLE IF NOT EXISTS transport_locations (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id   INT UNSIGNED NOT NULL,
  provider_id  INT UNSIGNED NOT NULL,
  lat          DECIMAL(9,6) NOT NULL,
  lng          DECIMAL(9,6) NOT NULL,
  accuracy_m   DECIMAL(8,1) NULL,
  speed_mps    DECIMAL(6,2) NULL,
  heading      DECIMAL(5,1) NULL,
  recorded_at  DATETIME NOT NULL,
  received_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tl_booking FOREIGN KEY (booking_id)
    REFERENCES transport_bookings(id) ON DELETE CASCADE,
  INDEX idx_tl_booking (booking_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The buyer's rating of the provider, once per completed booking.
CREATE TABLE IF NOT EXISTS transport_ratings (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id   INT UNSIGNED NOT NULL,
  provider_id  INT UNSIGNED NOT NULL,
  buyer_id     INT UNSIGNED NULL,
  stars        TINYINT UNSIGNED NOT NULL,
  feedback     VARCHAR(1000) NULL,
  hidden       TINYINT(1) NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tr_booking (booking_id),
  CONSTRAINT fk_tr_booking FOREIGN KEY (booking_id)
    REFERENCES transport_bookings(id) ON DELETE CASCADE,
  CONSTRAINT fk_tr_provider FOREIGN KEY (provider_id)
    REFERENCES transport_providers(id) ON DELETE CASCADE,
  INDEX idx_tr_provider (provider_id, hidden)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The buyer's rating of Frontier Marketplace, once per purchase (checkout),
-- for self-collection and transport alike. Kept apart from provider ratings.
CREATE TABLE IF NOT EXISTS platform_ratings (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  checkout_id      INT UNSIGNED NOT NULL,
  buyer_id         INT UNSIGNED NULL,
  delivery_option  ENUM('collect', 'transport') NOT NULL,
  stars            TINYINT UNSIGNED NOT NULL,
  feedback         VARCHAR(1000) NULL,
  hidden           TINYINT(1) NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pr_checkout (checkout_id),
  INDEX idx_pr_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
