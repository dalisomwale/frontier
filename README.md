# Frontier Marketplace v2

An admin-managed livestock discovery and inquiry platform for **Frontier Farms & Consult Ltd**.

Visitors **browse → filter → view livestock → inquire**, with no account needed. Every inquiry is saved to the database and emailed to the marketplace team. Administrators manage livestock, photos, categories, breeds and inquiries from a secure dashboard.

---

## What changed from v1

| v1 | v2 |
|---|---|
| Public registration, login, profiles, seller & user dashboards | **Removed.** Only administrators have accounts. |
| Anyone could create listings ("Sell") | **Only admins** create, edit, publish and delete listings |
| Buy and Message buttons, real-time chat (Socket.IO) | **One "Inquire" button** → inquiry form → database + email |
| Species filter (Cattle, Goats, Sheep…) with free-text breed/location and price/weight/health filters | **Cascading dropdowns:** Category → Breed → Province (Zambia's 10 provinces), all dropdowns. Price, weight and health filters removed. |
| Hero: generic pasture slideshow | Photographic hero of **real African cattle photography** (Zambia, Kenya, Nigeria, Senegal, Mauritania) |
| Tailwind compiled in the browser from the Play CDN | **Prebuilt Tailwind file**: same classes and look, faster, no third-party script |

The visual design (blue/navy brand, header, photo hero with the white filter card, card grid, gallery, navy admin sidebar, mobile bottom tabs) is kept.

---

## Tech stack

- **Frontend:** HTML, Tailwind CSS v3 (prebuilt), vanilla JavaScript
- **Backend:** Node.js 18+, Express 4
- **Database:** MySQL 8+ (MariaDB 10.5+ also works)
- **Packages:** bcrypt (password hashing), express-session + express-mysql-session (admin sessions stored in MySQL), helmet (security headers), express-rate-limit, multer + sharp (photo upload & WebP optimisation), nodemailer (inquiry emails), mysql2, dotenv

---

## Quick start (local)

```bash
npm install
cp .env.example .env          # then edit .env (database, SMTP, SESSION_SECRET)
npm run db:setup              # creates tables + seeds categories & breeds
npm run create-admin          # create your administrator login
npm run test-email            # optional: confirms SMTP works
npm run dev                   # http://localhost:3000
```

- Public site: `http://localhost:3000`
- Admin: `http://localhost:3000/admin/` (redirects to the login page)

There is **no demo data**. The database starts with the category/breed reference list only. Add livestock from the admin dashboard; until then the site shows empty states.

---

## Upgrading the live VPS from v1

The current production setup (InterServer VPS, PM2 process `Frontier`, Nginx, domain `marketplace.frontierfc.co.zm`) keeps working the same way.

1. **Back up the database first:**
   ```bash
   mysqldump -u frontier_user -p frontier_marketplace > ~/frontier-v1-backup-$(date +%F).sql
   ```
2. **Replace the code.** Extract this project over the old one (or `git pull` once it's committed). Keep the existing `.env` and `public/uploads/` folder.
3. **Install dependencies:**
   ```bash
   npm ci --omit=dev
   ```
4. **Add the new settings to `.env`.** Compare with `.env.example`. The new keys are `APP_URL`, `TRUST_PROXY`, `APP_TIMEZONE`, the `SMTP_*` settings, `MAIL_FROM` and `INQUIRY_NOTIFY_EMAILS`. In production `SESSION_SECRET` must be at least 32 characters, or the app refuses to start.
5. **Migrate the database:**
   ```bash
   npm run db:setup
   ```
   This **renames** the v1 tables (`users`, `listings`, `listing_media`, `listing_documents`, `messages`, `inquiries`, `favorites`, `reports`) to `legacy_v1_*`, so nothing is dropped. It then creates the v2 tables and seeds the 3 categories and 32 breeds. Existing **admin** accounts are copied into `admins` with their current passwords. Safe to run again on later deploys.
6. **Create an admin** if you don't already have one, or to reset a password:
   ```bash
   npm run create-admin
   ```
7. **Allow photo uploads through Nginx.** Nginx rejects request bodies over 1 MB by default, which blocks multi-photo uploads. In the site's `server { }` block:
   ```nginx
   client_max_body_size 60M;

   location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```
   `X-Forwarded-Proto` is needed for the secure admin cookie to work behind HTTPS. Then run `sudo nginx -t && sudo systemctl reload nginx`.
8. **Check email, then restart:**
   ```bash
   npm run test-email
   pm2 restart Frontier
   ```
9. Visit the site, sign in at `/admin/`, add a listing, publish it, and send a test inquiry from the public page.

Once you're happy with v2, you can drop the `legacy_v1_*` tables. v1 listing photos remain in `public/uploads/livestock/` and are not used by v2.

---

## Email notifications

Every inquiry is saved to the database **first**, then emailed to everyone in `INQUIRY_NOTIFY_EMAILS` (default: `mpimpa.miyoba@gmail.com, dalisomwale003@gmail.com`).

The email contains the livestock title, category, breed, the customer's name, phone, email and message, the date, and a button linking straight to the inquiry in the dashboard. *Reply-To* is set to the customer, so replying goes to them.

**Gmail:** turn on 2-Step Verification on the sending account, create an **App Password** (Google Account → Security → App passwords), and use it as `SMTP_PASS`. Any other SMTP provider works too; set `SMTP_HOST`, `SMTP_PORT` and `SMTP_SECURE` accordingly.

**If sending fails** (wrong password, provider down), the visitor still gets a success message, because the inquiry is safely stored. The dashboard then shows a warning, the inquiry is marked *Email failed*, and **Resend email** on the inquiry retries once SMTP is fixed.

SMTP credentials are only read on the server from `.env`. Nothing about email reaches the browser.

---

## Admin dashboard

| Page | What it does |
|---|---|
| **Dashboard** | Live counts from the database: total, published and unpublished livestock, categories, breeds, total and new inquiries. Also recent inquiries, recent livestock, and a failed-email warning. |
| **Livestock** | Add/edit/delete listings, publish or unpublish, and upload up to 10 photos (remove, set cover). Filter by status/category and search. |
| **Inquiries** | Tabs for New, Contacted, In Progress, Resolved and Archived, plus search. Each inquiry has one-tap Call / WhatsApp / Email, a status changer, archive/restore, delete, and resend email. Links in notification emails open the inquiry directly. |
| **Categories** | Add, edit, enable/disable, delete and order categories. Disabling hides the category and its listings from the website. |
| **Breeds** | Add, edit, enable/disable and delete breeds, and assign each to a category. A breed in use can't be deleted or moved to another category, so the public filter stays accurate. |

Photos are resized in the browser before upload (good on mobile data). The server then stores an optimised WebP (max 1600px) plus a 640px card thumbnail, typically 100–300 KB instead of several MB.

---

## Public filtering

The homepage filter cascades, and every option comes from the database:

**Category → Breed → Province**

- Breed stays disabled until a category is chosen, then lists only that category's breeds (e.g. Dairy → the 11 dairy breeds), with listing counts.
- Province always lists all 10 Zambian provinces (Central, Copperbelt, Eastern, Luapula, Lusaka, Muchinga, Northern, North-Western, Southern, Western), with listing counts for the earlier choices. Admins pick a listing's province from the same list.
- Filtering runs in MySQL with indexed queries and pagination. The browser never downloads the whole table.
- Filter selections are kept in the URL, so filtered results can be shared or bookmarked.

---

## Project structure

```
database/
  schema.sql            v2 tables (admins, categories, breeds, livestock, livestock_images, inquiries)
  seed-categories.sql   Dairy / Beef / Dual-Purpose + 32 breeds (reference data only)
  setup.js              npm run db:setup - create, migrate from v1, seed
scripts/
  create-admin.js       npm run create-admin
  test-email.js         npm run test-email
server/
  server.js             Express app, security headers, sessions, rate limits, v1 URL redirects
  db.js                 MySQL pool
  lib/validate.js       input validation helpers
  middleware/auth.js    admin-only auth + CSRF header check
  middleware/upload.js  photo upload, validation and WebP conversion (sharp)
  services/mailer.js    inquiry notification email (nodemailer)
  routes/public.js      public livestock, categories and cascading filter API
  routes/inquiries.js   public inquiry submission
  routes/admin/         auth, dashboard, livestock, taxonomy (categories + breeds), inquiries
public/
  index.html            homepage: hero, filters, categories, listings
  listing.html          livestock details + gallery + Inquire
  admin/                login, dashboard, livestock, inquiries, categories, breeds
  js/                   main, icons, app-shell, livestock, inquiry, admin
  css/style.css         brand styles (from v1, extended)
  css/tailwind.css      prebuilt Tailwind (generated - see below)
  uploads/livestock/    listing photos (created at runtime)
src/tailwind.css        Tailwind entry file
```

**After changing Tailwind classes** in any HTML/JS file, rebuild the stylesheet (needs dev dependencies, so run `npm install` without `--omit=dev`):

```bash
npm run build:css
```

---

## API

**Public**

| Method | Endpoint | |
|---|---|---|
| GET | `/api/categories` | Active categories with breed/listing counts |
| GET | `/api/livestock/filters?category_id=&breed_id=&type=` | Options for the dependent dropdowns |
| GET | `/api/livestock?category_id=&breed_id=&type=&location=&page=&limit=` | Published listings |
| GET | `/api/livestock/:id` | Listing details + photos |
| POST | `/api/inquiries` | `{ livestock_id, full_name, phone, email, message }` |
| GET | `/api/health` | Health check (app + database) |

**Admin** (session cookie + header `X-Frontier-Admin: 1` on every request)

| Method | Endpoint |
|---|---|
| POST | `/api/admin/auth/login`, `/api/admin/auth/logout` |
| GET | `/api/admin/auth/me` · PATCH `/api/admin/auth/me/password` |
| GET | `/api/admin/dashboard` |
| GET / POST | `/api/admin/livestock` (POST is multipart with `images[]`) |
| GET / PUT / DELETE | `/api/admin/livestock/:id` · PATCH `/api/admin/livestock/:id/status` |
| GET / POST / PUT / DELETE | `/api/admin/categories[/:id]`, `/api/admin/breeds[/:id]` |
| GET / PATCH / DELETE | `/api/admin/inquiries[/:id]` · POST `/api/admin/inquiries/:id/resend-email` |

---

## Security

- Admin passwords hashed with bcrypt (cost 12). Login timing doesn't reveal whether an email exists.
- Server-side sessions in MySQL: 8-hour idle timeout, regenerated on login, cookie `HttpOnly`, `SameSite=Strict`, scoped to `/api/admin` and `Secure` in production. Sessions survive PM2 restarts.
- Admin API requires a custom header, which blocks cross-site request forgery.
- Every query is parameterised. Inputs are validated server-side, and the same rules run in the browser for instant feedback.
- Uploads are re-encoded with sharp, so only real images are stored and EXIF metadata (including GPS) is stripped.
- Helmet security headers including a Content Security Policy. HSTS in production.
- Rate limits in production: login 10 / 15 min, inquiries 8 / hour per IP, plus a honeypot field against bots.
- Credentials only in `.env` (git-ignored). The app refuses to start in production without a strong `SESSION_SECRET`.

---

## Notes

- **No demo data.** Only the category/breed reference list is seeded. Dashboard numbers are live counts.
- **Hero photos** are real photographs from Unsplash (free licence). Credits are kept in `PHOTO-CREDITS.md` (not shown on the site).
- **Terms of Service and Privacy Policy** were rewritten for the inquiry-only model. Have them reviewed before relying on them legally.
