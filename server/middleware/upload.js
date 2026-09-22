const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = "public/uploads/livestock";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure storage for listing photos
const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `img-${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const mediaFilter = (req, file, cb) => {
  const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid image format. Only JPEG, PNG, WebP, and GIF are allowed."));
  }
};

const uploadMedia = multer({
  storage: mediaStorage,
  fileFilter: mediaFilter,
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

module.exports = {
  uploadMedia,
};
