const multer = require("multer");
const path = require("path");
const fs = require("fs");

const mediaDir = "public/uploads/livestock";
const documentDir = "public/uploads/documents";

for (const dir of [mediaDir, documentDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const VIDEO_MIMES = ["video/mp4", "video/webm", "video/quicktime"];
const VIDEO_EXTS = [".mp4", ".webm", ".mov"];

const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, mediaDir),
  filename: (req, file, cb) => {
    const isVideo = file.mimetype.startsWith("video/");
    const prefix = isVideo ? "vid" : "img";
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${prefix}-${uniqueSuffix}${ext}`);
  },
});

const mediaFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const isImage =
    IMAGE_MIMES.includes(file.mimetype) && IMAGE_EXTS.includes(ext);
  const isVideo =
    VIDEO_MIMES.includes(file.mimetype) && VIDEO_EXTS.includes(ext);
  if (isImage || isVideo) return cb(null, true);
  cb(
    new Error(
      "Only JPEG, PNG, WebP, GIF images and MP4, WebM, MOV videos are allowed.",
    ),
  );
};

// Videos are capped at 50MB (vs 10MB for images) since uncompressed phone
// video easily exceeds 10MB for a few seconds of footage. If you later add
// server-side transcoding (batch 3+), this is where the ffmpeg call hooks in.
const uploadMedia = multer({
  storage: mediaStorage,
  fileFilter: mediaFilter,
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, documentDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `doc-${uniqueSuffix}.pdf`);
  },
});

const documentFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.mimetype === "application/pdf" && ext === ".pdf") {
    return cb(null, true);
  }
  cb(new Error("Only PDF documents are allowed."));
};

const uploadDocument = multer({
  storage: documentStorage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

module.exports = {
  uploadMedia,
  uploadDocument,
};
