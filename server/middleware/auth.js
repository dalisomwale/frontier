// Authentication and authorization middleware. Roles and account status are
// refreshed from the database so a suspended account cannot keep using an old
// browser session.
const pool = require("../db");

// Check if user is authenticated
const isAuthenticated = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res
      .status(401)
      .json({ success: false, message: "Authentication required" });
  }

  try {
    const [users] = await pool.query(
      "SELECT id, role, status, name FROM users WHERE id = ?",
      [req.session.userId],
    );
    const user = users[0];
    if (!user) {
      req.session.destroy(() => {});
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    }
    if (user.status !== "active") {
      return res
        .status(403)
        .json({ success: false, message: "This account has been suspended" });
    }
    req.session.userRole = user.role;
    req.session.userName = user.name;
    return next();
  } catch (error) {
    return next(error);
  }
};

// Check if user has specific role
const hasRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.session.userRole)) {
      return res.status(403).json({
        success: false,
        message: "Access denied - insufficient permissions",
      });
    }

    return next();
  };
};

// Check if user is admin
const isAdmin = (req, res, next) => {
  return hasRole("admin")(req, res, next);
};

// Check if user is a member - the single marketplace-participant role that
// can both buy and sell from the same account (there is no separate
// buyer/seller distinction).
const isMember = (req, res, next) => {
  return hasRole("member")(req, res, next);
};

// Check if user is service provider
const isServiceProvider = (req, res, next) => {
  return hasRole("service_provider")(req, res, next);
};

module.exports = {
  isAuthenticated,
  hasRole,
  isAdmin,
  isMember,
  isServiceProvider,
};
