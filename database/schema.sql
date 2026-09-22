-- Frontier Marketplace database schema
-- Run this once against a fresh database to create every table the app's
-- routes rely on. Safe to re-run: each statement uses IF NOT EXISTS.

CREATE DATABASE IF NOT EXISTS frontier_marketplace
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE frontier_marketplace;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(255) NOT NULL,
  email               VARCHAR(255) NOT NULL UNIQUE,
  phone               VARCHAR(20)  NULL,
  password_hash       VARCHAR(255) NOT NULL,
  -- A "member" can both buy and sell from the same account - there is no
  -- separate buyer/seller distinction. service_provider and admin remain
  -- their own distinct roles.
  role                ENUM('member', 'service_provider', 'admin') NOT NULL,
  location            VARCHAR(255) NOT NULL,
  service_description TEXT NULL,
  profile_image       VARCHAR(500) NULL,
  status              ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role (role),
  INDEX idx_users_status (status)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- listings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listings (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  seller_id     INT UNSIGNED NOT NULL,
  title         VARCHAR(255) NOT NULL,
  species       VARCHAR(100) NOT NULL,
  location      VARCHAR(255) NOT NULL,
  price         DECIMAL(12, 2) NOT NULL,
  description   TEXT NULL,
  status        ENUM('pending', 'active', 'approved', 'rejected', 'paused', 'deactivated', 'sold')
                  NOT NULL DEFAULT 'active',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_listings_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_listings_status (status),
  INDEX idx_listings_species (species),
  INDEX idx_listings_seller (seller_id),
  INDEX idx_listings_price (price),
  INDEX idx_listings_created (created_at)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- listing_media (images/videos)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_media (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  listing_id  INT UNSIGNED NOT NULL,
  file_path   VARCHAR(500) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_media_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  INDEX idx_media_listing (listing_id)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sender_id    INT UNSIGNED NOT NULL,
  receiver_id  INT UNSIGNED NOT NULL,
  listing_id   INT UNSIGNED NULL,
  message      TEXT NOT NULL,
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_receiver FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL,
  INDEX idx_messages_sender (sender_id),
  INDEX idx_messages_receiver (receiver_id),
  INDEX idx_messages_conversation (sender_id, receiver_id, created_at)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- inquiries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inquiries (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  listing_id  INT UNSIGNED NOT NULL,
  buyer_id    INT UNSIGNED NOT NULL,
  seller_id   INT UNSIGNED NOT NULL,
  message     TEXT NOT NULL,
  status      ENUM('pending', 'responded', 'closed') NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_inquiries_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  CONSTRAINT fk_inquiries_buyer FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_inquiries_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_inquiries_buyer (buyer_id),
  INDEX idx_inquiries_seller (seller_id)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- favorites
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorites (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  listing_id  INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_favorites_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_favorites_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_favorite (user_id, listing_id)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reporter_id       INT UNSIGNED NOT NULL,
  reported_user_id  INT UNSIGNED NULL,
  listing_id        INT UNSIGNED NULL,
  message_id        INT UNSIGNED NULL,
  reason            VARCHAR(255) NOT NULL,
  status            ENUM('pending', 'reviewed', 'resolved') NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_reports_reported_user FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_reports_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  CONSTRAINT fk_reports_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  INDEX idx_reports_status (status)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;