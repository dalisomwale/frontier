// Seller password rules, shared by the browser (live feedback) and the server
// (the final check), so both always agree:
//   - at least 6 characters (and at most 200)
//   - no spaces
//   - not one of the most common passwords
//   - not the seller's own phone number or email
// No uppercase / number / symbol requirements.
(function (root) {
  const MIN = 6;
  const MAX = 200;
  const COMMON = [
    "123456", "1234567", "12345678", "123456789", "1234567890", "123123", "654321", "112233", "121212",
    "111111", "000000", "222222", "555555", "666666", "777777", "888888", "999999", "123321", "159753",
    "password", "password1", "passw0rd", "qwerty", "qwerty123", "abc123", "abcdef", "abcd1234", "asdfgh",
    "zxcvbn", "iloveyou", "letmein", "welcome", "monkey", "dragon", "football", "secret", "admin", "admin123",
    "frontier", "frontier1", "frontier123", "zambia", "zambia1", "zambia123", "lusaka", "lusaka123",
    "farmer", "farmer123", "cattle", "livestock",
  ];

  function digits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  // Returns the problem as a sentence, or "" when the password is fine.
  function problem(password, { email = "", phone = "" } = {}) {
    const pw = String(password || "");
    if (!pw) return "Please choose a password.";
    if (/\s/.test(pw)) return "Passwords can't contain spaces.";
    if (pw.length < MIN) return `Password must be at least ${MIN} characters.`;
    if (pw.length > MAX) return "Password is too long.";
    const lower = pw.toLowerCase();
    if (COMMON.includes(lower) || /^(.)\1+$/.test(pw)) return "Too easy to guess. Try something else.";
    const mail = String(email || "").trim().toLowerCase();
    if (mail && (lower === mail || lower === mail.split("@")[0])) return "Don't use your email address as your password.";
    const phoneDigits = digits(phone);
    const pwDigits = digits(pw);
    if (phoneDigits.length >= 6 && pwDigits === pw && (pwDigits === phoneDigits || phoneDigits.endsWith(pwDigits) || pwDigits.endsWith(phoneDigits.slice(-9)))) {
      return "Don't use your phone number as your password.";
    }
    return "";
  }

  const rules = { MIN, MAX, problem };
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  else root.PasswordRules = rules;
})(typeof window !== "undefined" ? window : globalThis);
