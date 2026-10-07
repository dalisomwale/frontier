# Frontier Marketplace v2

An admin-managed livestock discovery and inquiry platform for **Frontier Farms & Consult Ltd**.

Visitors **browse → filter → view livestock → inquire**, with no account needed. Every inquiry is saved to the database and emailed to the marketplace team. Administrators manage livestock, photos, animals, production purposes, breeds and inquiries from a secure dashboard.

Farmers can also **register as sellers** (header → Register). Frontier approves each account, then reviews every listing a seller submits before it goes live. Customer inquiries still come to Frontier first; the team passes them on to the seller without the customer's contact details.

---

## What changed from v1

| v1 | v2 |
|---|---|
| Public registration, login, profiles, seller & user dashboards | Replaced by **seller accounts** that Frontier approves, with listing review. Buyers need no account. |
| Anyone could create listings ("Sell") | Admins create listings, and approved sellers submit them. **Only admins** publish. |
| Buy and Message buttons, real-time chat (Socket.IO) | **One "Inquire" button** → inquiry form → database + email |
| Species filter (Cattle, Goats, Sheep…) with free-text breed/location and price/weight/health filters | **Cascading dropdowns:** Animal Category → Production Purpose → Breed → Province (Zambia's 10 provinces). Price, weight and health filters removed. |
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
npm run db:setup              # creates tables + seeds animals, purposes & breeds
npm run create-admin          # create your administrator login
npm run test-email            # optional: confirms SMTP works
npm run dev                   # http://localhost:3000
```

- Public site: `http://localhost:3000`
- Admin: `http://localhost:3000/admin/` (redirects to the login page)

There is **no demo data**. The database starts with the animal / purpose / breed reference list only. Add livestock from the admin dashboard; until then the site shows empty states.

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
   This **renames** the v1 tables (`users`, `listings`, `listing_media`, `listing_documents`, `messages`, `inquiries`, `favorites`, `reports`) to `legacy_v1_*`, so nothing is dropped. It then creates the v2 tables and seeds the reference list (5 animals, 15 production purposes, 65 breeds). Existing **admin** accounts are copied into `admins` with their current passwords. Safe to run again on later deploys. Databases set up before animal categories existed are upgraded in place: the existing Dairy / Beef / Dual-Purpose become Cattle's purposes (listings, breeds and inquiries are kept) and the other animals are added.
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

The email contains the livestock title, category (animal · purpose, e.g. *Goats · Meat*), breed, the customer's name, phone, email and message, the date, and a button linking straight to the inquiry in the dashboard. *Reply-To* is set to the customer, so replying goes to them.

**Gmail:** turn on 2-Step Verification on the sending account, create an **App Password** (Google Account → Security → App passwords), and use it as `SMTP_PASS`. Any other SMTP provider works too; set `SMTP_HOST`, `SMTP_PORT` and `SMTP_SECURE` accordingly.

**Checking it works:**
- When the app starts, its log says `Inquiry emails: ON - via smtp.gmail.com…` or `Inquiry emails: OFF - <what's missing>` (`pm2 logs Frontier --lines 20`).
- `npm run test-email` prints the settings it found (never the password), signs in, and sends a test notification, with a plain-language explanation if anything fails.
- The admin **Dashboard** shows whether inquiry emails are on, with **Send test email** and **Resend failed** buttons.

**If sending fails** (missing settings, wrong password, blocked port), the visitor still gets a success message, because the inquiry is safely stored. The inquiry is marked *Email failed* with the reason, and once the settings are fixed, **Resend failed** on the dashboard (or **Resend email** on one inquiry) sends them.

SMTP credentials are only read on the server from `.env`. Nothing about email reaches the browser.

---

## Admin dashboard

| Page | What it does |
|---|---|
| **Dashboard** | Live counts from the database: total, published and unpublished livestock, animals, purposes, breeds, total and new inquiries. Also recent inquiries, recent livestock, and a failed-email warning. |
| **Livestock** | **Pending review** lists what sellers have submitted or changed. One status dropdown per listing: Published (for a seller's listing this approves it, marks it verified and emails the seller), Unpublished, or Changes requested with a note the seller sees. Add/edit/delete listings; set each one Published/Unpublished and Verified/Unverified from dropdowns (the publish date is recorded automatically); and upload up to 10 photos (remove, set cover). Animal → Purpose → Breed dropdowns, and a Type list that fits the animal (Bull/Cow…, Buck/Doe…, Hen/Pullet…). Filter by status/animal and search. |
| **Inquiries** | A two-pane inbox: the list on the left (filter by status or seller, search) and the selected inquiry as a conversation on the right. The customer's message, the message sent to the seller and the seller's reply show as chat bubbles. The header has Call / WhatsApp / Email for the customer, a status dropdown, archive and delete. The message box at the bottom sends a message to the seller (their dashboard and email), or opens it in WhatsApp or the email app. The customer's name, phone and email are never sent. On phones the list and the conversation are separate screens with a back button.
| **Categories & Purposes** | Add, edit, enable/disable and delete animal categories (Cattle, Goats, Sheep, Pigs, Poultry…) and each animal's production purposes, with photos set in the Add and Edit forms: one **photo** per animal (upload / replace / remove) and up to **8 photos** per production purpose (add, remove, make first), shown on their tiles on the website. New items are added at the end. Disabling hides it and its listings from the website. |
| **Breeds** | Add, edit, enable/disable and delete breeds, each assigned to one animal's production purpose. A breed in use can't be deleted or moved, so the public filter stays accurate. |
| **Sellers** | Sellers who register on the website appear under **Awaiting approval**. Each seller's status dropdown sets Approved (they can then submit listings), Rejected (with a note) or Deactivated. Both send the seller an email. Admins can also add, edit, activate/deactivate and delete the farmers and suppliers whose livestock is listed (name, farm/business, phone, email, province, address, private notes). Each seller's page shows their listings and every inquiry about them, with call/WhatsApp/email shortcuts. Listings pick a seller in the Livestock form; inquiries record the seller and the notification email names them. A seller with listings can't be deleted. Sellers are admin-only: visitors never see them, and every inquiry still comes to Frontier. |

Photos are resized in the browser before upload (good on mobile data). The server then stores an optimised WebP (max 1600px) plus a 640px card thumbnail, typically 100–300 KB instead of several MB.

---

## Seller accounts

| Page | What it does |
|---|---|
| `/seller/register.html` | Name, farm/business, phone, email, province, town and password. The account starts as *awaiting approval* and the admins are emailed. |
| `/seller/login.html`, `forgot.html`, `reset.html` | Sign in; reset a forgotten password by email (link valid for 1 hour, single use). |
| `/seller/` | **My Listings**: add and edit listings, with their status (*In review*, *Changes needed* with Frontier's note, *Live*, *Hidden*). A new listing needs at least one photo, and the description is limited to 50 words. Only Frontier can hide or delete a listing. Any edit takes a live listing off the website until it is approved again. **Messages**: inquiries Frontier has passed on, with a reply box. **Profile**: details and password. |

Rules enforced by the server (`server/routes/seller.js`, mounted at `/api/seller`):

- Sellers can only see and change their own listings and messages.
- Only approved, active accounts can submit listings; a deactivated seller is signed out.
- Sellers can't set a listing's status, verification or seller. Every submission is unpublished and *pending* until an admin approves it.
- Messages never include the customer's name, phone, email or original message.
- Seller sessions use their own cookie (`frontier.seller`, path `/api/seller`, 7 days) and store (`seller_sessions`), separate from admin sessions. State-changing requests need the `X-Frontier-Seller: 1` header. Register, login and password reset are rate limited.

Emails to sellers (approval, listing approved or changes needed, forwarded inquiries, password reset) use the same SMTP settings and `APP_URL` for links.

The same events also appear in the seller dashboard straight away: a bell with an unread count, a pop-up, and the page refreshing its listings and messages. They are stored in `seller_notifications` and pushed live over Server-Sent Events (`/api/seller/notifications/stream`). Behind Nginx this needs no extra setup: the app sends `X-Accel-Buffering: no` and a heartbeat every 25 seconds.

---

## Public filtering

The homepage filter cascades, and every option comes from the database:

**Search:** the header search box matches every word typed against listing titles, descriptions, types, provinces, animals, purposes and breeds (`GET /api/livestock?q=`), shows the top matches as you type, and Enter shows all results in the listings.

**Animal Category → Production Purpose → Breed → Province**

- No dropdown offers an "All …" option; each shows a prompt (e.g. *Select breed*) until something is picked, and **Clear all filters** resets them.
- Production Purpose stays locked until an animal is chosen, then lists only that animal's purposes. Breed stays locked until a purpose is chosen, then lists only that purpose's breeds (e.g. Goats → Meat → Boer, Kalahari Red, Savanna; Poultry → Layers → Lohmann Brown, ISA Brown, Hy-Line Brown). Visitors never see a breed that doesn't belong to their choices. The exception is **Dual-Purpose**: since dual-purpose stock can be any breed of its animal, its Breed list shows all of that animal's breeds, grouped by purpose (Dual-Purpose's own first), and admins can list e.g. a dual-purpose Jersey.

| Animal | Production purposes |
|---|---|
| Cattle | Dairy, Beef, Dual-Purpose |
| Goats | Meat, Dairy, Dual-Purpose |
| Sheep | Meat, Wool, Dual-Purpose |
| Pigs | Meat, Commercial |
| Poultry | Layers, Broilers, Dual-Purpose, Breeding |

**Photo tiles:** the homepage shows animal tiles; choosing an animal (tile or dropdown) switches them to that animal's production-purpose tiles, and clicking one filters the listings. Animal tiles show one photo (uploaded, else a recent listing photo, else a stock photo). **Purpose tiles slide through their photos** inside the card (about every 4 seconds, staggered; the text stays still; paused for visitors who prefer reduced motion), using the uploaded photos, else recent listing photos, else the animal's photo.

Cattle breeds come from the client's cattle breed reference document. The other animals' breeds are common Zambian / Southern African breeds; review them in Admin → Breeds.
- Province always lists all 10 Zambian provinces (Central, Copperbelt, Eastern, Luapula, Lusaka, Muchinga, Northern, North-Western, Southern, Western), with listing counts for the earlier choices. Admins pick a listing's province from the same list.
- Filtering runs in MySQL with indexed queries and pagination. The browser never downloads the whole table.
- Filter selections are kept in the URL, so filtered results can be shared or bookmarked.

---

## Project structure

```
database/
  schema.sql            v2 tables (admins, animals, categories = production purposes, category_images, breeds, livestock, livestock_images, inquiries)
  seed-taxonomy.sql     5 animals, 15 production purposes, 65 breeds (reference data only)
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
  routes/public.js      public livestock, animals, purposes and cascading filter API
  routes/inquiries.js   public inquiry submission
  routes/admin/         auth, dashboard, livestock, taxonomy (animals, purposes, breeds), inquiries
public/
  index.html            homepage: hero, filters, animal tiles, listings
  listing.html          livestock details + gallery + Inquire
  admin/                login, dashboard, livestock, inquiries, animals & purposes, breeds
  js/                   main, icons, app-shell, livestock, inquiry, admin
  css/style.css         brand styles (from v1, extended)
  css/tailwind.css      prebuilt Tailwind (generated - see below)
  uploads/livestock/    listing photos (created at runtime)
  uploads/taxonomy/     animal & production-purpose photos (created at runtime)
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
| GET | `/api/animals` | Active animal categories with purpose/listing counts |
| GET | `/api/categories?animal_id=` | Active production purposes |
| GET | `/api/livestock/filters?animal_id=&category_id=&breed_id=` | Options for the dependent dropdowns |
| GET | `/api/livestock?animal_id=&category_id=&breed_id=&location=&page=&limit=` | Published listings |
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
| GET / POST / PUT / DELETE | `/api/admin/animals[/:id]`, `/api/admin/categories[/:id]`, `/api/admin/breeds[/:id]` |
| POST / DELETE | `/api/admin/animals/:id/photo` (multipart field `image`) |
| POST · DELETE · PUT | `/api/admin/categories/:id/photos` (multipart `images`, up to 8) · `/:id/photos/:photoId` · `/:id/photos/order` `{ order: [ids] }` |
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

- **No demo data.** Only the animal / purpose / breed reference list is seeded. Dashboard numbers are live counts.
- **Hero photos** are real photographs from Unsplash (free licence). Credits are kept in `PHOTO-CREDITS.md` (not shown on the site).
- **Terms of Service and Privacy Policy** were rewritten for the inquiry-only model. Have them reviewed before relying on them legally.
