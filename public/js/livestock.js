
const HERO_PHOTOS = [
  { video: "/images/hero/hero-reel-1.mp4", src: "/images/hero/hero-reel-1.webp", alt: "Video of cattle grazing in a meadow in the evening light", label: "Cattle grazing" },
  { video: "/images/hero/hero-reel-2.mp4", src: "/images/hero/hero-reel-2.webp", alt: "Video of brown and white cows grazing on a green hillside", label: "Cows on the hillside" },
];

const ANIMAL_PHOTOS = {
  cattle: { src: () => unsplashUrl("photo-1735837844277-e1206881f9c9", 900, 675), alt: "A herd of cattle beside water" },
  goats: { src: () => "/images/livestock/goat.webp", alt: "A brown goat looking at the camera" },
  sheep: { src: () => "/images/livestock/sheep.webp", alt: "Sheep grazing" },
  pigs: { src: () => "/images/livestock/pig.webp", alt: "A pig on a farm" },
  poultry: { src: () => "/images/livestock/poultry.webp", alt: "A brown hen on grass" },
  default: { src: () => "/images/livestock/cattle-fallback.webp", alt: "Livestock" },
};

function unsplashUrl(id, width, height) {
  const params = new URLSearchParams({ auto: "format", fit: "crop", w: String(width), q: "70" });
  if (height) params.set("h", String(height));
  return `https://images.unsplash.com/${id}?${params}`;
}

function viewportImageWidth(max = 2000) {
  const px = Math.ceil((window.innerWidth * Math.min(window.devicePixelRatio || 1, 2)) / 400) * 400;
  return Math.min(max, Math.max(800, px));
}

function animalPhoto(animal) {
  return ANIMAL_PHOTOS[String(animal.name || "").toLowerCase()] || ANIMAL_PHOTOS.default;
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

function verifiedBadge(item) {
  if (item.verification !== "verified") return "";
  return `<span class="verified-badge" title="Verified by Frontier"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 21.5l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2z"/><path d="M8.5 12.2l2.3 2.3 4.7-4.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Verified</span>`;
}

// Prices are optional. "K 18,500" with "per head" / "for the lot".
function hasPrice(item) {
  return item.price !== null && item.price !== undefined && item.price !== "" && Number(item.price) > 0;
}

function kwacha(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `K ${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function priceUnitLabel(item, short = false) {
  if (item.price_unit === "lot") return short ? "lot" : "for the lot";
  const unit = item.animal_name === "Poultry" ? "bird" : "head";
  return short ? `/ ${unit}` : `per ${unit}`;
}

function cardPrice(item) {
  if (!hasPrice(item)) return `<div class="lv-price-row"><span class="lv-price-request">Price on request</span></div>`;
  return `<div class="lv-price-row">
    <span class="lv-price">${kwacha(item.price)}</span>
    <span class="lv-price-unit"><span class="lbl-full">${priceUnitLabel(item)}</span><span class="lbl-short">${priceUnitLabel(item, true)}</span></span>
    ${Number(item.price_negotiable) ? '<span class="lv-price-tag">Negotiable</span>' : ""}
  </div>`;
}

function renderLivestockCard(item) {
  const typeLine = [item.livestock_type, item.quantity > 1 ? quantityLabel(item.quantity, item.animal_name) : ""]
    .filter(Boolean)
    .join(", ");
  const buyable = hasPrice(item);

  return `
    <article class="lv-card">
      <div class="lv-card-media">${cardImage(item)}${verifiedBadge(item)}</div>
      <div class="p-2.5 sm:p-3 flex flex-col flex-1">
        <h3 class="text-xs sm:text-sm font-semibold text-gray-900 line-clamp-2 mb-1">
          <a href="${listingUrl(item.id)}" class="lv-card-link">${escapeHtml(item.title)}</a>
        </h3>
        <div class="flex items-center justify-between gap-2 min-w-0 text-[11px] sm:text-xs text-gray-500 mb-1.5">
          <span class="flex items-center gap-1 min-w-0"><span class="meta-icon">${uiIcon("location")}</span><span class="truncate">${escapeHtml(item.location)}</span></span>
          ${typeLine ? `<span class="whitespace-nowrap">${escapeHtml(typeLine)}</span>` : ""}
        </div>
        ${cardPrice(item)}
        <div class="buy-row mt-auto ${buyable ? "" : "buy-row-single"}">
          ${buyable ? `<button type="button" class="btn-buy" data-buy="${item.id}">Buy Now</button>` : ""}
          <button type="button" class="btn-contact btn-inquire" data-inquire="${item.id}">
            ${buyable ? '<span class="lbl-full">Contact Seller</span><span class="lbl-short">Contact</span>' : "Contact Seller"}
          </button>
        </div>
      </div>
    </article>`;
}

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
  container.querySelectorAll("[data-buy]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = byId.get(btn.dataset.buy);
      if (item) openBuyModal(item);
    });
  });
}
