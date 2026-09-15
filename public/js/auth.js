// Authentication Functions

/**
 * Check if user is authenticated
 */
async function checkAuthentication() {
  try {
    const response = await fetch("/api/auth/check");
    const data = await response.json();

    if (data.success && data.authenticated) {
      // User is authenticated
      showAuthenticatedNav(data.data);
      return true;
    } else {
      // User is not authenticated
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

    // Add admin link if user is admin
    if (user.role === "admin") {
      const adminLink = document.createElement("a");
      adminLink.href = "admin/index.html";
      adminLink.className = "text-gray-600 hover:text-gray-900 font-medium";
      adminLink.textContent = "Admin";
      authenticatedNav.insertBefore(adminLink, authenticatedNav.lastChild);
    }
  }

  // Store user in localStorage for frontend use
  localStorage.setItem("user", JSON.stringify(user));
}

/**
 * Hide authenticated navigation
 */
function hideAuthenticatedNav() {
  const authNav = document.getElementById("nav-auth");
  const authenticatedNav = document.getElementById("nav-authenticated");

  // Clear any inline override from showAuthenticatedNav() so nav-auth falls
  // back to its own responsive classes (hidden on phones, visible on desktop)
  // instead of being forced to a fixed display value at every breakpoint.
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

    // Store the session user immediately so the next page's requireAuth()
    // check (which runs synchronously, before checkAuthentication() has a
    // chance to populate this) doesn't bounce the user straight back here.
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
 * Login user
 */
async function login(email, password) {
  try {
    const data = await apiRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    // Store the session user immediately so the next page's requireAuth()
    // check (which runs synchronously, before checkAuthentication() has a
    // chance to populate this) doesn't bounce the user straight back here.
    localStorage.setItem("user", JSON.stringify(data.data));

    showNotification("Login successful! Redirecting...", "success");
    setTimeout(() => {
      window.location.href =
        data.data.role === "admin" ? "/admin/index.html" : "/dashboard.html";
    }, 1500);
    return true;
  } catch (error) {
    console.error("Login error:", error);
    showNotification(error.message || "Login failed", "error");
    return false;
  }
}

/**
 * Logout user
 */
async function logout() {
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
 * Check if user is authenticated and redirect if not. Returns whether the
 * caller should continue - callers must stop their own init on false,
 * since the redirect above doesn't halt the current script by itself.
 * Uses replace() rather than an href assignment so this page never becomes
 * a back-button entry a signed-out visitor would just get bounced off of
 * again - important both for ordinary navigation and for a tab-frame
 * iframe (see app-shell.js), where an href assignment here adds a second
 * entry to the browser's shared joint session history that can make the
 * back button step through the iframe's own redirect before it affects the
 * visible tab.
 */
function requireAuth() {
  if (!getCurrentUser()) {
    window.location.replace("/login.html");
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
  if (getCurrentUser()) {
    window.location.href = "/dashboard.html";
  }
}
