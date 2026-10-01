-- ===========================================================================
-- Frontier Marketplace - database schema (v2: admin-managed inquiry platform)
-- ===========================================================================
-- Prefer `npm run db:setup`, which runs this file against DB_NAME from .env,
-- archives any v1 tables first and seeds the category/breed reference list.
--
-- Running it by hand also works:
--   mysql -u <user> -p <database> < database/schema.sql
--   mysql -u <user> -p <database> < database/seed-categories.sql
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

-- categories: Dairy, Beef, Dual-Purpose (admins can add more) ---------------
CREATE TABLE IF NOT EXISTS categories (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  description  TEXT NULL,
  status       ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_categories_name (name),
  INDEX idx_categories_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- breeds: each belongs to exactly one category ------------------------------
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

-- livestock: listings, created by administrators only -----------------------
-- livestock_type is the "other classification" step of the public filter
-- (Category -> Breed -> Type -> Location).
CREATE TABLE IF NOT EXISTS livestock (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title           VARCHAR(200) NOT NULL,
  category_id     INT UNSIGNED NOT NULL,
  breed_id        INT UNSIGNED NULL,
  livestock_type  ENUM('Bull', 'Cow', 'Heifer', 'Steer', 'Calf', 'Mixed') NULL,
  quantity        INT UNSIGNED NOT NULL DEFAULT 1,
  age_months      SMALLINT UNSIGNED NULL,
  location        VARCHAR(150) NOT NULL,
  description     TEXT NULL,
  status          ENUM('published', 'unpublished') NOT NULL DEFAULT 'unpublished',
  created_by      INT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_livestock_category FOREIGN KEY (category_id)
    REFERENCES categories(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_livestock_breed FOREIGN KEY (breed_id)
    REFERENCES breeds(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_livestock_admin FOREIGN KEY (created_by)
    REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_livestock_public (status, category_id, breed_id),
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
  category_name    VARCHAR(100) NULL,
  breed_name       VARCHAR(120) NULL,
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
