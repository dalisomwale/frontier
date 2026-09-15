const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure upload directories exist
const uploadDirs = [
  "public/uploads/livestock",
  "public/uploads/videos",
  "public/uploads/documents",
];

uploadDirs.forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure storage for livestock images
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads/livestock");
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "img-" + uniqueSuffix + path.extname(file.originalname));
  },
});

// Configure storage for videos
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads/videos");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "vid-" + uniqueSuffix + path.extname(file.originalname));
  },
});

// Configure storage for documents
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads/documents");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "doc-" + uniqueSuffix + path.extname(file.originalname));
  },
});

// A single listing-media endpoint accepts a bounded mix of images and short
// videos. The storage location is selected from the verified MIME type, never
// from the original filename or a client supplied path.
const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, file.mimetype.startsWith("video/") ? "public/uploads/videos" : "public/uploads/livestock");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const prefix = file.mimetype.startsWith("video/") ? "vid" : "img";
    cb(null, `${prefix}-${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`);
  },
});

// File filter for images
const imageFilter = (req, file, cb) => {
  const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid image format. Only JPEG, PNG, WebP, and GIF are allowed.",
      ),
    );
  }
};

// File filter for videos
const videoFilter = (req, file, cb) => {
  const allowedMimes = ["video/mp4", "video/webm", "video/quicktime"];
  const allowedExtensions = [".mp4", ".webm", ".mov"];

  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid video format. Only MP4, WebM, and MOV are allowed."));
  }
};

// File filter for documents
const documentFilter = (req, file, cb) => {
  const allowedMimes = ["application/pdf"];
  const allowedExtensions = [".pdf"];

  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid document format. Only PDF is allowed."));
  }
};

const mediaFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const images = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const videos = ["video/mp4", "video/webm", "video/quicktime"];
  const imageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
  const videoExtensions = [".mp4", ".webm", ".mov"];
  if ((images.includes(file.mimetype) && imageExtensions.includes(ext)) ||
      (videos.includes(file.mimetype) && videoExtensions.includes(ext))) {
    return cb(null, true);
  }
  return cb(new Error("Only JPEG, PNG, WebP, GIF, MP4, WebM, and MOV files are allowed."));
};

// Multer instances
const uploadImage = multer({
  storage: imageStorage,
  fileFilter: imageFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

const uploadVideo = multer({
  storage: videoStorage,
  fileFilter: videoFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
});

const uploadDocument = multer({
  storage: documentStorage,
  fileFilter: documentFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

const uploadMedia = multer({
  storage: mediaStorage,
  fileFilter: mediaFilter,
  limits: { fileSize: 100 * 1024 * 1024, files: 10 },
});

module.exports = {
  uploadImage,
  uploadVideo,
  uploadDocument,
  uploadMedia,
};
