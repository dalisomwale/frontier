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

// Proof of payment to a seller: photos or PDF files (up to 4). Field: "images".
const PROOF_MIMES = [...ALLOWED_MIMES, "application/pdf"];
const uploadProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 4 },
  fileFilter: (req, file, cb) => {
    if (PROOF_MIMES.includes(file.mimetype)) return cb(null, true);
    return cb(badRequest("Proof of payment must be a photo (JPEG, PNG, WebP) or a PDF."));
  },
}).array("images", 4);

// A PDF is kept as it is, once its first bytes show it really is a PDF.
async function savePdf(buffer) {
  if (!buffer || buffer.length < 8 || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw badRequest("One of the files is not a valid PDF.");
  }
  const name = `pop-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.pdf`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, name), buffer);
  const publicPath = `${PUBLIC_PREFIX}/${name}`;
  return { image_path: publicPath, thumb_path: publicPath };
}

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

// Several photos for a production purpose's slideshow. Field name: "images".
const MAX_PURPOSE_PHOTOS = 8;
const uploadPurposeImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_PURPOSE_PHOTOS },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    return cb(badRequest("Photos must be JPEG, PNG or WebP images."));
  },
}).array("images", MAX_PURPOSE_PHOTOS);

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

// ---------------------------------------------------------------------------
// Transport.
//   Collection and delivery photos: images only, up to 6 per step (field
//   "images"), saved like order photos.
//   Provider and vehicle papers (licences, permits, registration): PDF or
//   photo, kept outside the public folder (storage/transport) and served only
//   to the provider and Frontier's admins.
// ---------------------------------------------------------------------------
const TRANSPORT_PHOTOS = 6;
const uploadTransportPhotos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: TRANSPORT_PHOTOS },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    return cb(badRequest("Photos must be JPEG, PNG or WebP images."));
  },
}).array("images", TRANSPORT_PHOTOS);

const PRIVATE_DIR = path.join(__dirname, "..", "..", "storage", "transport");
fs.mkdirSync(PRIVATE_DIR, { recursive: true });
const DOC_MIMES = [...ALLOWED_MIMES, "application/pdf"];
const MAX_DOCS = 6;
const docFilter = (req, file, cb) => {
  if (file.fieldname === "photos") {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    return cb(badRequest("Vehicle photos must be JPEG, PNG or WebP images."));
  }
  if (DOC_MIMES.includes(file.mimetype)) return cb(null, true);
  return cb(badRequest("Documents must be a PDF or a photo (JPEG, PNG or WebP)."));
};
// Registration and "add documents": field "documents".
const uploadDocuments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_DOCS },
  fileFilter: docFilter,
}).array("documents", MAX_DOCS);
// A vehicle: "photos" (public) and "documents" (private).
const uploadVehicleFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 4 + MAX_DOCS },
  fileFilter: docFilter,
}).fields([{ name: "photos", maxCount: 4 }, { name: "documents", maxCount: MAX_DOCS }]);

// Checks the file really is what it claims (a PDF or a decodable image) and
// stores it privately. Images are re-encoded, which also drops any hidden
// content. Returns { file_name, mime, size_bytes }.
async function savePrivateDocument(file) {
  const id = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  if (file.mimetype === "application/pdf") {
    const buffer = file.buffer;
    if (!buffer || buffer.length < 8 || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw badRequest(`${file.originalname || "A file"} is not a valid PDF.`);
    }
    const name = `doc-${id}.pdf`;
    await fs.promises.writeFile(path.join(PRIVATE_DIR, name), buffer);
    return { file_name: name, mime: "application/pdf", size_bytes: buffer.length };
  }
  let image;
  try {
    image = sharp(file.buffer, { failOn: "error" }).rotate();
    await image.metadata();
  } catch {
    throw badRequest(`${file.originalname || "A file"} is not a valid image.`);
  }
  const name = `doc-${id}.webp`;
  const info = await image.resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(PRIVATE_DIR, name));
  return { file_name: name, mime: "image/webp", size_bytes: info.size };
}

// Absolute path of a private document, or null when the name isn't one of ours.
function privateDocumentPath(fileName) {
  const name = path.basename(String(fileName || ""));
  if (!/^doc-[\w-]+\.(pdf|webp)$/.test(name)) return null;
  return path.join(PRIVATE_DIR, name);
}

function deletePrivateDocuments(...names) {
  for (const n of names) {
    const p = privateDocumentPath(n);
    if (p) fs.unlink(p, () => {});
  }
}

module.exports = {
  uploadTransportPhotos,
  TRANSPORT_PHOTOS,
  uploadDocuments,
  uploadVehicleFiles,
  savePrivateDocument,
  privateDocumentPath,
  deletePrivateDocuments,
  uploadImages,
  uploadProof,
  savePdf,
  saveImage,
  deleteImageFiles,
  MAX_FILES,
  uploadSingleImage,
  saveTaxonomyImage,
  deleteTaxonomyImage,
  uploadPurposeImages,
  MAX_PURPOSE_PHOTOS,
};
