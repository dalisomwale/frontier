// Livestock photo uploads (admin only).
//
// Files are received into memory, validated by actually decoding them with
// sharp (not just trusting the extension/MIME), then written as:
//   - a large WebP, max 1600px wide  -> details page / gallery
//   - a WebP thumbnail, 640px wide   -> listing cards
// so a 6 MB phone photo becomes roughly 150-300 KB and the homepage stays fast.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const { badRequest } = require("../lib/validate");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "livestock");
const PUBLIC_PREFIX = "/uploads/livestock";
const TAXONOMY_DIR = path.join(__dirname, "..", "..", "public", "uploads", "taxonomy");
const TAXONOMY_PREFIX = "/uploads/taxonomy";
const MAX_FILES = 10;
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIMES = ["image/jpeg", "image/png", "image/webp"];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TAXONOMY_DIR, { recursive: true });

const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    return cb(badRequest("Photos must be JPEG, PNG or WebP images."));
  },
}).array("images", MAX_FILES);

// One photo for an animal category or production purpose, used as a 4:3
// tile on the website. Field name: "image".
const uploadSingleImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    return cb(badRequest("Photos must be JPEG, PNG or WebP images."));
  },
}).single("image");

async function saveTaxonomyImage(buffer, prefix) {
  let image;
  try {
    image = sharp(buffer, { failOn: "error" }).rotate();
    await image.metadata();
  } catch {
    throw badRequest("That file is not a valid image.");
  }
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.webp`;
  await image
    .resize({ width: 1200, height: 900, fit: "cover", position: "attention" })
    .webp({ quality: 76 })
    .toFile(path.join(TAXONOMY_DIR, name));
  return `${TAXONOMY_PREFIX}/${name}`;
}

function deleteTaxonomyImage(publicPath) {
  if (!publicPath || !publicPath.startsWith(`${TAXONOMY_PREFIX}/`)) return;
  fs.unlink(path.join(TAXONOMY_DIR, path.basename(publicPath)), () => {});
}

async function saveImage(buffer) {
  const id = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const largeName = `lv-${id}.webp`;
  const thumbName = `lv-${id}-thumb.webp`;

  let image;
  try {
    image = sharp(buffer, { failOn: "error" }).rotate(); // honour EXIF orientation
    await image.metadata();
  } catch {
    throw badRequest("One of the files is not a valid image.");
  }

  await image
    .clone()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(path.join(UPLOAD_DIR, largeName));
  await image
    .clone()
    .resize({ width: 640, height: 480, fit: "cover", position: "attention" })
    .webp({ quality: 72 })
    .toFile(path.join(UPLOAD_DIR, thumbName));

  return {
    image_path: `${PUBLIC_PREFIX}/${largeName}`,
    thumb_path: `${PUBLIC_PREFIX}/${thumbName}`,
  };
}

// Only ever deletes files inside the upload directory.
function deleteImageFiles(...publicPaths) {
  for (const publicPath of publicPaths) {
    if (!publicPath || !publicPath.startsWith(`${PUBLIC_PREFIX}/`)) continue;
    const filename = path.basename(publicPath);
    fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
  }
}

module.exports = {
  uploadImages,
  saveImage,
  deleteImageFiles,
  MAX_FILES,
  uploadSingleImage,
  saveTaxonomyImage,
  deleteTaxonomyImage,
};
