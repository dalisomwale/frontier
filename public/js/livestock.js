// Public listing helpers: hero/category photography, listing cards.

// Real photographs from Unsplash (free Unsplash License - commercial use
// allowed, no permission needed). Every photo was checked on its Unsplash
// page: location, camera and photographer are recorded below and in
// PHOTO-CREDITS.md. Served from Unsplash's CDN, resized to the viewport.
const HERO_PHOTOS = [
  {
    id: "photo-1771172032297-7c42b11af31d",
    alt: "A brown and white calf resting in green grass in Kabwe, Zambia",
    place: "Kabwe, Zambia",
    author: "Mwandwe Chileshe",
    page: "https://unsplash.com/photos/a-brown-and-white-calf-rests-in-green-grass-_q4s7f6JTTU",
  },
  {
    id: "photo-1735837844277-e1206881f9c9",
    alt: "A herd of cattle beside water in Kenya's Great Rift Valley",
    place: "Great Rift Valley, Kenya",
    author: "Sweder Breet",
    page: "https://unsplash.com/photos/a-herd-of-cattle-standing-next-to-a-body-of-water-Cjbb9aeHeD8",
  },
  {
    id: "photo-1763231228595-12e443569896",
    alt: "A farmer milking a white cow in a field in Osun, Nigeria",
    place: "Osun, Nigeria",
    author: "Fahd Aminu",
    page: "https://unsplash.com/photos/man-milking-a-white-cow-in-a-field-NQg7R0euxyc",
  },
  {
    id: "photo-1713289590437-65e4db863617",
    alt: "A herd of cattle walking down a dirt road in Senegal",
    place: "Senegal",
    author: "Carlos Torres",
    page: "https://unsplash.com/photos/a-herd-of-cattle-walking-down-a-dirt-road-QS_0VPaTpco",
  },
  {
    id: "photo-1782944597444-c5406882e171",
    alt: "Cattle walking in single file along a dry path through tall reeds",
    place: "Mauritania",
    author: "Baptiste Riethmann",
    page: "https://unsplash.com/photos/cattle-walking-along-a-dry-path-with-tall-reeds-6WIV4VXsRA4",
  },
];

// Photography for the category tiles when a category has no listing photos
// of its own yet. Matched by category name; anything else uses the default.
const CATEGORY_PHOTOS = {
  dairy: HERO_PHOTOS[2],
  beef: HERO_PHOTOS[1],
  "dual-purpose": HERO_PHOTOS[0],
  default: HERO_PHOTOS[3],
};

function unsplashUrl(id, width, height) {
  const params = new URLSearchParams({ auto: "format", fit: "crop", w: String(width), q: "70" });
  if (height) params.set("h", String(height));
  return `https://images.unsplash.com/${id}?${params}`;
}

// Width that fills the screen without downloading more pixels than needed.
function viewportImageWidth(max = 2000) {
  const px = Math.ceil((window.innerWidth * Math.min(window.devicePixelRatio || 1, 2)) / 400) * 400;
  return Math.min(max, Math.max(800, px));
}

function categoryPhoto(category) {
  return CATEGORY_PHOTOS[String(category.name || "").toLowerCase()] || CATEGORY_PHOTOS.default;
}

function listingUrl(id) {
  return `/listing.html?id=${encodeURIComponent(id)}`;
}

function cardImage(item) {
  if (!item.thumb_path) return livestockFallbackMedia();
  const srcset = item.image_path ? `${item.thumb_path} 640w, ${item.image_path} 1600w` : "";
  return `<img src="${escapeHtml(item.thumb_path)}" ${srcset ? `srcset="${escapeHtml(srcset)}"` : ""}
    sizes="(min-width:1024px) 25vw, (min-width:768px) 33vw, 50vw"
    alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" width="640" height="480">`;
}

function renderLivestockCard(item) {
  const meta = [
    item.category_name ? `<span class="tag tag-category">${escapeHtml(item.category_name)}</span>` : "",
    item.breed_name ? `<span class="tag tag-breed">${escapeHtml(item.breed_name)}</span>` : "",
  ].join("");
  const typeLine = [item.livestock_type, item.quantity > 1 ? `${item.quantity} head` : ""]
    .filter(Boolean)
    .join(" · ");

  return `
    <article class="lv-card">
      <div class="lv-card-media">${cardImage(item)}</div>
      <div class="p-2.5 sm:p-3 flex flex-col flex-1">
        <div class="flex flex-wrap gap-1 mb-1.5">${meta}</div>
        <h3 class="text-xs sm:text-sm font-semibold text-gray-900 line-clamp-2 mb-1">
          <a href="${listingUrl(item.id)}" class="lv-card-link">${escapeHtml(item.title)}</a>
        </h3>
        <div class="flex items-center justify-between gap-2 min-w-0 text-[11px] sm:text-xs text-gray-500 mb-1.5">
          <span class="flex items-center gap-1 min-w-0"><span class="meta-icon">${uiIcon("location")}</span><span class="truncate">${escapeHtml(item.location)}</span></span>
          ${typeLine ? `<span class="whitespace-nowrap">${escapeHtml(typeLine)}</span>` : ""}
        </div>
        ${item.description ? `<p class="hidden sm:block text-xs text-gray-600 line-clamp-2 mb-2">${escapeHtml(item.description)}</p>` : ""}
        <button type="button" class="inquire-btn mt-auto w-full inline-flex items-center justify-center gap-1.5 bg-blue-600 text-white text-xs sm:text-sm font-semibold px-3 py-2 rounded-lg hover:bg-blue-700 transition"
          data-inquire="${item.id}">
          <span class="w-4 h-4 inline-flex">${uiIcon("inquire")}</span> Inquire
        </button>
      </div>
    </article>`;
}

// Wires every [data-inquire] button inside `container` to the inquiry form.
function bindInquireButtons(container, items) {
  const byId = new Map(items.map((item) => [String(item.id), item]));
  container.querySelectorAll("[data-inquire]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = byId.get(btn.dataset.inquire);
      if (item) openInquiryModal(item);
    });
  });
}
