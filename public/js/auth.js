// Authentication Functions

/**
 * Check if user is authenticated
 */
async function checkAuthentication() {
  try {
    const response = await fetch("/api/auth/check");
    const data = await response.json();

    if (data.success && data.authenticated) {
      showAuthenticatedNav(data.data);
      return true;
    } else {
      hideAuthenticatedNav();
      return false;
    }
  } catch (error) {
    console.error("Auth check error:", error);
    hideAuthenticatedNav();
    return false;
  }
}

/**
 * Show authenticated navigation
 */
function showAuthenticatedNav(user) {
  const authNav = document.getElementById("nav-auth");
  const authenticatedNav = document.getElementById("nav-authenticated");

  if (authNav) authNav.style.display = "none";
  if (authenticatedNav) {
    authenticatedNav.classList.remove("hidden");
    authenticatedNav.style.display = "flex";

    if (user.role === "admin") {
      const adminLink = document.createElement("a");
      adminLink.href = "admin/index.html";
      adminLink.className = "text-gray-600 hover:text-gray-900 font-medium";
      adminLink.textContent = "Admin";
      authenticatedNav.insertBefore(adminLink, authenticatedNav.lastChild);
    }
  }

  localStorage.setItem("user", JSON.stringify(user));
}

/**
 * Hide authenticated navigation
 */
function hideAuthenticatedNav() {
  const authNav = document.getElementById("nav-auth");
  const authenticatedNav = document.getElementById("nav-authenticated");

  if (authNav) authNav.style.display = "";
  if (authenticatedNav) {
    authenticatedNav.classList.add("hidden");
    authenticatedNav.style.display = "none";
  }

  localStorage.removeItem("user");
}

/**
 * Register user
 */
async function register(formData) {
  try {
    const data = await apiRequest("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(formData),
    });

    localStorage.setItem("user", JSON.stringify(data.data));

    showNotification("Registration successful! Redirecting...", "success");
    setTimeout(() => {
      window.location.href = "/dashboard.html";
    }, 1500);
    return true;
  } catch (error) {
    console.error("Registration error:", error);
    showNotification(error.message || "Registration failed", "error");
    return false;
  }
}

/**
 * Return a same-origin destination from a `next` query parameter, or null if
 * the value is missing, empty, or not a safe in-app path. Blocks absolute
 * URLs (`https://evil.com`) and protocol-relative URLs (`//evil.com`) that
 * would otherwise turn the login page into an open redirector.
 */
function getSafeNextPath() {
  const next = getQueryParams().next;
  if (!next || typeof next !== "string") return null;
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//")) return null;
  return next;
}

/**
 * Login user. If the page was opened with a `?next=/path` query parameter
 * (set by goToLogin when a signed-out user tried to do something that needs
 * an account), the user is returned there after a successful sign-in.
 * Otherwise they land on their role's default page.
 */
async function login(email, password) {
  try {
    const data = await apiRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    localStorage.setItem("user", JSON.stringify(data.data));

    showNotification("Login successful! Redirecting...", "success");
    setTimeout(() => {
      const defaultDest =
        data.data.role === "admin" ? "/admin/index.html" : "/dashboard.html";
      window.location.href = getSafeNextPath() || defaultDest;
    }, 1500);
    return true;
  } catch (error) {
    console.error("Login error:", error);
    showNotification(error.message || "Login failed", "error");
    return false;
  }
}

/**
 * Logout user. Confirmed via a modal because it ends the session, which on
 * shared devices is easy to trigger by accident.
 */
async function logout() {
  const confirmed = await confirmAction({
    title: "Log out?",
    message: "You'll need to sign in again to access your account.",
    confirmText: "Log out",
    variant: "danger",
  });
  if (!confirmed) return;

  try {
    await apiRequest("/api/auth/logout", { method: "POST" });

    showNotification("Logged out successfully", "success");
    localStorage.removeItem("user");
    setTimeout(() => {
      window.location.href = "/";
    }, 1000);
  } catch (error) {
    console.error("Logout error:", error);
    showNotification(error.message || "Logout failed", "error");
  }
}

/**
 * Get current user from localStorage
 */
function getCurrentUser() {
  const userStr = localStorage.getItem("user");
  return userStr ? JSON.parse(userStr) : null;
}

/**
 * Send a signed-out visitor to login, tagging the destination with a
 * `reason` so login.html can explain why it interrupted them, and (optionally)
 * a `next` path to return to after a successful sign-in.
 *
 * `replace: true` avoids adding a back-button entry - see requireAuth().
 * `next` must be a same-origin path starting with "/"; absolute and
 * protocol-relative URLs are silently dropped.
 */
function goToLogin(reason, { replace = false, next = null } = {}) {
  const params = new URLSearchParams();
  if (reason) params.set("reason", reason);
  if (
    next &&
    typeof next === "string" &&
    next.startsWith("/") &&
    !next.startsWith("//")
  ) {
    params.set("next", next);
  }
  const query = params.toString();
  const url = `/login.html${query ? `?${query}` : ""}`;
  if (replace) window.location.replace(url);
  else window.location.href = url;
}

/**
 * Check if user is authenticated and redirect if not. Returns whether the
 * caller should continue.
 */
function requireAuth(reason) {
  if (!getCurrentUser()) {
    goToLogin(reason, { replace: true });
    return false;
  }
  return true;
}

/**
 * Check if user has specific role
 */
function hasRole(role) {
  const user = getCurrentUser();
  return user && user.role === role;
}

/**
 * Redirect non-authenticated users
 */
function redirectIfAuthenticated() {
  const user = getCurrentUser();
  if (!user) return;
  window.location.href =
    user.role === "admin" ? "/admin/index.html" : "/dashboard.html";
}
