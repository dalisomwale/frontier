# Frontier Marketplace - Phase 1

A professional, production-ready livestock trading platform connecting buyers, sellers, and service providers through a centralized digital marketplace.

## 🚀 Project Overview

Frontier Marketplace is an online platform for Frontier Farms & Consult Ltd that enables:

- **Buyers** to browse and purchase livestock from verified sellers
- **Sellers** to create and manage livestock listings
- **Service Providers** to offer ancillary services
- **Administrators** to moderate the platform

## 🛠 Technology Stack

### Frontend

- HTML5
- Tailwind CSS
- Vanilla JavaScript (ES6+)

### Backend

- Node.js
- Express.js
- MySQL

### Real-time Communication

- Socket.IO

### Supporting Packages

- bcrypt (password hashing)
- express-session (session management)
- multer (file uploads)
- dotenv (environment configuration)
- helmet (security)
- cors (cross-origin requests)
- express-rate-limit (rate limiting)
- mysql2 (database driver)

## ✨ Phase 1 Features

### Authentication

- User registration (buyer, seller, service provider)
- Secure login/logout
- Password hashing with bcrypt
- Session-based authentication

### Marketplace

- Browse livestock listings
- Server-side search and filtering
- Category browsing (Cattle, Goats, Sheep, Pigs, Poultry, Other)
- Listing details page

### Seller Features

- Create livestock listings with descriptions
- Upload multiple images and videos
- Upload supporting documents (PDF)
- Manage listings (edit, pause, deactivate, delete)
- View listing inquiries
- Track active listings

### Buyer Features

- Search and filter listings
- View listing details with media
- Send inquiries to sellers
- Favorite listings
- Real-time messaging with sellers

### Admin Features

- Dashboard with marketplace statistics
- User management (suspend, activate)
- Listing moderation (approve, reject)
- Report management

### Real-time Messaging

- Socket.IO for live chat
- Message history
- Message read status
- Conversation management

## 📋 Requirements

- Node.js 14.0 or higher
- MySQL 5.7 or higher
- npm 6.0 or higher

## 🔧 Installation

### 1. Clone/Copy Project Files

```bash
cd frontier
npm install
```

### 2. Setup MySQL Database

```bash
# Login to MySQL
mysql -u root -p

# Create database
CREATE DATABASE frontier_marketplace;

# Use database
USE frontier_marketplace;

# Import schema
source database/schema.sql;

# Exit
exit
```

### 3. Configure Environment Variables

```bash
# Copy example to actual .env file
cp .env.example .env

# Edit .env with your configuration
nano .env
```

Example `.env`:

```
PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=frontier_marketplace
DB_PORT=3306
SESSION_SECRET=your_session_secret_key
NODE_ENV=development
CORS_ORIGIN=http://localhost:5000
```

### 4. Start the Server

#### Development Mode (with auto-reload)

```bash
npm run dev
```

#### Production Mode

```bash
npm start
```

Server will start on `http://localhost:5000` (or your configured PORT)

## 📁 Project Structure

```
frontier-marketplace/
├── public/                          # Frontend files
│   ├── index.html                   # Homepage
│   ├── login.html                   # Login page
│   ├── register.html                # Registration page
│   ├── marketplace.html             # Listings marketplace
│   ├── listing.html                 # Single listing details
│   ├── dashboard.html               # User dashboard
│   ├── profile.html                 # User profile
│   ├── messages.html                # Messaging interface
│   ├── admin/                       # Admin pages
│   │   ├── index.html               # Admin dashboard
│   │   ├── users.html               # User management
│   │   ├── listings.html            # Listing moderation
│   │   └── reports.html             # Report management
│   ├── css/
│   │   └── style.css                # Custom styles
│   ├── js/
│   │   ├── main.js                  # Utility functions
│   │   ├── auth.js                  # Authentication logic
│   │   ├── marketplace.js           # Marketplace logic
│   │   ├── listing.js               # Listing management
│   │   ├── dashboard.js             # Dashboard logic
│   │   ├── messages.js              # Messaging logic
│   │   └── admin.js                 # Admin logic
│   └── uploads/                     # File uploads
│       ├── livestock/               # Product images
│       ├── videos/                  # Product videos
│       └── documents/               # PDF documents
│
├── server/                          # Backend server
│   ├── server.js                    # Main server file
│   ├── db.js                        # Database connection
│   ├── routes/
│   │   ├── auth.js                  # Authentication routes
│   │   ├── users.js                 # User routes
│   │   ├── listings.js              # Listing routes
│   │   ├── messages.js              # Message routes
│   │   └── admin.js                 # Admin routes
│   └── middleware/
│       ├── auth.js                  # Authentication middleware
│       └── upload.js                # File upload middleware
│
├── database/
│   └── schema.sql                   # Database schema
│
├── .env.example                     # Environment template
├── .gitignore                       # Git ignore rules
├── package.json                     # Node dependencies
└── README.md                        # This file
```

## 📡 API Endpoints

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/logout` - Logout user
- `POST /api/auth/forgot-password` - Forgot password
- `GET /api/auth/check` - Check authentication status

### Users

- `GET /api/users/profile` - Get current user profile
- `PUT /api/users/profile` - Update user profile
- `GET /api/users/:id` - Get public user info

### Listings

- `GET /api/listings` - Get public listings
- `GET /api/listings/:id` - Get listing details
- `POST /api/listings` - Create listing (sellers)
- `PUT /api/listings/:id` - Update listing (sellers)
- `PATCH /api/listings/:id/status` - Update listing status
- `DELETE /api/listings/:id` - Delete listing
- `POST /api/listings/:id/media` - Upload media

### Messages

- `GET /api/messages` - Get conversations
- `GET /api/messages/:userId` - Get message history
- `POST /api/messages` - Send message

### Admin

- `GET /api/admin/stats` - Dashboard statistics
- `GET /api/admin/users` - Get users
- `PATCH /api/admin/users/:id/status` - Suspend/activate user
- `GET /api/admin/listings` - Get all listings
- `PATCH /api/admin/listings/:id/approve` - Approve listing
- `PATCH /api/admin/listings/:id/reject` - Reject listing
- `GET /api/admin/reports` - Get reports
- `PATCH /api/admin/reports/:id` - Update report status

## 🔐 Security Features

- **Password Hashing**: bcrypt with salt rounds
- **Session Management**: Express-session with secure cookies
- **CORS Protection**: Configured for trusted origins only
- **Security Headers**: Helmet middleware
- **Rate Limiting**: Prevents brute-force attacks
- **SQL Injection Protection**: Parameterized queries
- **File Upload Validation**: MIME type and extension checks
- **Secure File Naming**: Randomized upload filenames

## 🚨 Important Notes

### No Demo Data

- The application starts with an **empty database**
- No pre-populated users, listings, or test data
- All data must be created through the actual application interface

### Empty States

When the database is empty, pages display appropriate messages:

- "No livestock listings available yet."
- "You haven't saved any livestock listings yet."
- "You don't have any conversations yet."

### Production Deployment

Before deploying to production:

1. **Change Session Secret**

   ```
   SESSION_SECRET=your_very_secure_random_string_here
   ```

2. **Set Secure Cookies**

   ```
   NODE_ENV=production
   ```

3. **Use HTTPS**

   ```
   Ensure CORS_ORIGIN uses https://
   ```

4. **Database Backup**

   ```bash
   mysqldump -u root -p frontier_marketplace > backup.sql
   ```

5. **Environment Variables**
   - Never commit `.env` to version control
   - Use secure configuration management for production

## 🧪 Testing Checklist

### Authentication

- [ ] User registration with valid data
- [ ] User registration with duplicate email
- [ ] User login with correct credentials
- [ ] User login with incorrect credentials
- [ ] Logout functionality
- [ ] Session persistence

### Listings

- [ ] Seller creates listing
- [ ] Listing appears as pending
- [ ] Admin approves listing
- [ ] Listing appears public after approval
- [ ] Seller can edit own listing
- [ ] Seller cannot edit other listings
- [ ] Buyer can view listings

### Search & Filter

- [ ] Filter by species
- [ ] Filter by location
- [ ] Filter by price range
- [ ] Sort by price
- [ ] Sort by date
- [ ] Pagination works correctly

### Media Uploads

- [ ] Image upload validation
- [ ] Video upload validation
- [ ] Document upload validation
- [ ] Invalid file rejection

### Messaging

- [ ] Send message between users
- [ ] Real-time message delivery
- [ ] Message read status
- [ ] Conversation history

### Admin Features

- [ ] View dashboard statistics
- [ ] Approve/reject listings
- [ ] Suspend users
- [ ] View reports

### Security

- [ ] Cannot access other user's data
- [ ] Cannot modify other user's listings
- [ ] Unauthenticated users cannot access protected endpoints
- [ ] SQL injection attempts are blocked
- [ ] Invalid files cannot be uploaded

## 📞 Support

For issues or questions:

- Check the console for error messages
- Review database connection in `.env`
- Ensure all required dependencies are installed
- Check MySQL is running
- Verify database schema was imported correctly

## 📝 License

All rights reserved. Frontier Farms & Consult Ltd.

## ✅ Phase 1 Completion Criteria

- [x] User authentication and role-based access control
- [x] Marketplace with search and filtering
- [x] Listing creation and management
- [x] Media uploads (images, videos, documents)
- [x] Real-time messaging with Socket.IO
- [x] Admin moderation tools
- [x] Responsive design with Tailwind CSS
- [x] Production-ready security
- [x] Empty database at startup
- [x] No demo or seed data

## 🚀 Phase 2 Preview (Not Included)

The following features belong to Phase 2 and are NOT implemented in Phase 1:

- Livestock certification verification workflow
- Veterinarian dashboard
- Admin certification approval process
- Transporter marketplace
- Advanced analytics

## 🏦 Phase 3 Preview (Not Included)

Payment processing belongs to Phase 3:

- Mobile Money integration (Airtel Money)
- Bank transfers
- Payment gateway integration
- Escrow system
- Commission engine
- Automated invoicing

---

**Frontier Marketplace Phase 1** - A real, working livestock trading platform.
