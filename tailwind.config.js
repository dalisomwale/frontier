/** Tailwind v3 build config. Run `npm run build:css` after changing classes
 *  in any HTML/JS file; the output (public/css/tailwind.css) is committed so
 *  servers don't need a build step. */
module.exports = {
  content: ["./public/**/*.html", "./public/js/**/*.js"],
  theme: { extend: {} },
  plugins: [],
};
