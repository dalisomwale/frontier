// Pictorial building blocks shared across every page: small line-icon SVGs
// for livestock species and core navigation actions, plus the photo used to
// represent each species when a listing has no photo of its own.

const SPECIES_ICON_SVG = {
  Cattle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="6"/><path d="M9 6.5c-.6-1.6.4-2.8 1.6-1.8M15 6.5c.6-1.6-.4-2.8-1.6-1.8"/><ellipse cx="6.4" cy="9.4" rx="1.9" ry="1.3" transform="rotate(-25 6.4 9.4)"/><ellipse cx="17.6" cy="9.4" rx="1.9" ry="1.3" transform="rotate(25 17.6 9.4)"/><circle cx="10.5" cy="15" r="0.6" fill="currentColor" stroke="none"/><circle cx="13.5" cy="15" r="0.6" fill="currentColor" stroke="none"/></svg>`,
  Goats: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="6"/><path d="M10 7c-1-2 0-3.6 1-4.4M14 7c1-2 0-3.6-1-4.4"/><ellipse cx="6" cy="12.5" rx="2.1" ry="1.2" transform="rotate(-12 6 12.5)"/><ellipse cx="18" cy="12.5" rx="2.1" ry="1.2" transform="rotate(12 18 12.5)"/><circle cx="10.5" cy="14.5" r="0.6" fill="currentColor" stroke="none"/><circle cx="13.5" cy="14.5" r="0.6" fill="currentColor" stroke="none"/><path d="M12 17v2"/></svg>`,
  Sheep: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7.5" r="2.3"/><circle cx="13.6" cy="6.6" r="2.6"/><circle cx="17" cy="8.6" r="2.2"/><circle cx="6.2" cy="9.6" r="2"/><circle cx="12" cy="14" r="4.6"/><ellipse cx="6.8" cy="14" rx="1.5" ry="1" transform="rotate(-20 6.8 14)"/><ellipse cx="17.2" cy="14" rx="1.5" ry="1" transform="rotate(20 17.2 14)"/><circle cx="10.3" cy="14.5" r="0.5" fill="currentColor" stroke="none"/><circle cx="13.7" cy="14.5" r="0.5" fill="currentColor" stroke="none"/></svg>`,
  Pigs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="6"/><polygon points="6.4,7.2 9.6,8.4 7.2,10.4" stroke-linejoin="round"/><polygon points="17.6,7.2 14.4,8.4 16.8,10.4" stroke-linejoin="round"/><ellipse cx="12" cy="14.5" rx="3.1" ry="2.1"/><circle cx="10.8" cy="14.5" r="0.5" fill="currentColor" stroke="none"/><circle cx="13.2" cy="14.5" r="0.5" fill="currentColor" stroke="none"/></svg>`,
  Poultry: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7.6 6.2c.2-1.1 1.1-1.8 2-1.4.8.4.8 1.5.1 2.1"/><circle cx="9.4" cy="9" r="2.8"/><polygon points="5.6,9 3.2,9.9 5.6,10.8" stroke-linejoin="round"/><path d="M6.4 12.5c-1.2 2.2-1 5.1.8 6.9 2.2 2.2 6 2.2 8.2 0 1.7-1.7 2-4.3 1-6.4"/><path d="M9.5 19.5l-1 2M15 19l1.2 2"/></svg>`,
  Other: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V11L12 5l8 6v10"/><path d="M4 11h16"/><path d="M9.5 21v-6h5v6"/></svg>`,
};

const SPECIES_IMAGE = {
  Cattle: "/images/livestock/cattle.jpg",
  Goats: "/images/livestock/goat.jpg",
  Sheep: "/images/livestock/sheep.jpg",
  Pigs: "/images/livestock/pig.jpg",
  Poultry: "/images/livestock/poultry.jpg",
  Other: "/images/livestock/hero-pasture.jpg",
};

const UI_ICON_SVG = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
  messages: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.4 8.4 0 0 1 12.5 3a8.5 8.5 0 0 1 8.5 8.5z"/></svg>`,
  profile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>`,
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.3 14.1c2.5.4 4.2 2.1 4.2 4.9"/></svg>`,
  listings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z"/><path d="M8 11h8M8 14.5h8M8 18h5"/></svg>`,
  reports: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18"/><path d="M5 4h13l-3 4 3 4H5"/></svg>`,
  logout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
  heart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.6-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.4-9.5 9-9.5 9z"/></svg>`,
  location: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-11a7 7 0 1 0-14 0c0 4.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg>`,
};

function speciesIcon(species, extraClass = "") {
  const svg = SPECIES_ICON_SVG[species] || SPECIES_ICON_SVG.Other;
  return `<span class="species-icon ${extraClass}">${svg}</span>`;
}

function speciesImage(species) {
  return SPECIES_IMAGE[species] || SPECIES_IMAGE.Other;
}

function uiIcon(name) {
  return UI_ICON_SVG[name] || "";
}

/**
 * Standard "no photo" fallback markup for a listing card: the species icon
 * on a soft tint instead of a blank grey box or "No image" text.
 */
function speciesFallbackMedia(species) {
  return `<div class="w-full h-full flex items-center justify-center bg-blue-50">${speciesIcon(species, "w-16 h-16")}</div>`;
}
