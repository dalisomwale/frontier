// Everything under /api/admin. Only /auth/login and /auth/logout are
// reachable without a signed-in administrator.
const express = require("express");
const { requireAdmin, requireAdminHeader } = require("../../middleware/auth");
const { animals, categories, breeds } = require("./taxonomy");

const router = express.Router();

router.use(requireAdminHeader);
router.use("/auth", require("./auth"));

router.use(requireAdmin);
router.use("/dashboard", require("./dashboard"));
router.use("/livestock", require("./livestock"));
router.use("/animals", animals);
router.use("/categories", categories);
router.use("/breeds", breeds);
router.use("/inquiries", require("./inquiries"));

module.exports = router;
