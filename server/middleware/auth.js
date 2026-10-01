// Admin-only authentication. There are no public accounts on the platform.
//
// Sessions are server-side (stored in MySQL) and the admin row is re-checked
// on every request, so deleting an admin locks them out immediately.
const pool = require("../db");

async function requireAdmin(req, res, next) {
  const adminId = req.session?.adminId;
  if (!adminId) {
    return res
      .status(401)
      .json({ success: false, message: "Please sign in to continue." });
  }
  try {
    const [rows] = await pool.query(
      "SELECT id, name, email FROM admins WHERE id = ?",
      [adminId],
    );
    if (!rows.length) {
      req.session.destroy(() => {});
      return res
        .status(401)
        .json({ success: false, message: "Please sign in to continue." });
    }
    req.admin = rows[0];
    return next();
  } catch (error) {
    return next(error);
  }
}

// CSRF defence for the admin API. Browsers will not let another site attach
// a custom header to a cross-origin request without a CORS preflight (which
// our CORS policy refuses), so requiring it on every state-changing request
// blocks forged form posts that would otherwise ride the session cookie.
function requireAdminHeader(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Frontier-Admin") === "1") return next();
  return res
    .status(403)
    .json({ success: false, message: "Request blocked (missing admin header)." });
}

module.exports = { requireAdmin, requireAdminHeader };
