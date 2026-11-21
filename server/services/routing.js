// Road distances for transport (never straight-line).
//
// One of three routing services, chosen in .env:
//   ROUTING_PROVIDER=ors     OpenRouteService   ORS_API_KEY=...
//   ROUTING_PROVIDER=google  Google Routes API  GOOGLE_MAPS_API_KEY=...
//   ROUTING_PROVIDER=osrm    an OSRM server     OSRM_URL=https://your-osrm-server
// With none set up, routing is "off": the checkout does not offer transport,
// because the fee cannot be worked out without a real road distance.
//
//   route(from, to)      -> { km, minutes, geometry: [[lat, lng], ...], provider }
//   matrix(sources, dests) -> km[sourceIndex][destIndex] (null = no road route)
// Points are { lat, lng }. Results are cached for 30 minutes per point pair.
const TIMEOUT_MS = 15000;
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map();

function provider() {
  const name = String(process.env.ROUTING_PROVIDER || "").trim().toLowerCase();
  if (name === "ors" && process.env.ORS_API_KEY) return "ors";
  if (name === "google" && process.env.GOOGLE_MAPS_API_KEY) return "google";
  if (name === "osrm" && process.env.OSRM_URL) return "osrm";
  return null;
}
const enabled = () => Boolean(provider());

// What is wrong with the setup, for the admin pages.
function problem() {
  const name = String(process.env.ROUTING_PROVIDER || "").trim().toLowerCase();
  if (!name) return "No road-distance service is set up (ROUTING_PROVIDER in .env).";
  if (name === "ors" && !process.env.ORS_API_KEY) return "ROUTING_PROVIDER is ors but ORS_API_KEY is empty.";
  if (name === "google" && !process.env.GOOGLE_MAPS_API_KEY) return "ROUTING_PROVIDER is google but GOOGLE_MAPS_API_KEY is empty.";
  if (name === "osrm" && !process.env.OSRM_URL) return "ROUTING_PROVIDER is osrm but OSRM_URL is empty.";
  if (!["ors", "google", "osrm"].includes(name)) return `Unknown ROUTING_PROVIDER "${name}" (use ors, google or osrm).`;
  return null;
}

class RoutingError extends Error {
  constructor(message, { noRoute = false } = {}) {
    super(message);
    this.noRoute = noRoute;
  }
}

function validPoint(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;
}
const key = (p) => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const raw = await res.text();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const message = (body && (body.error?.message || body.error || body.message)) || raw.slice(0, 200) || `HTTP ${res.status}`;
      throw new RoutingError(`Road-distance service error: ${typeof message === "string" ? message : JSON.stringify(message)}`, { noRoute: res.status === 404 });
    }
    return body;
  } catch (error) {
    if (error instanceof RoutingError) throw error;
    throw new RoutingError(error.name === "AbortError" ? "The road-distance service did not answer in time." : `Road-distance service unreachable: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Google's encoded polyline -> [[lat, lng], ...]
function decodePolyline(str) {
  const out = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

// Keeps the stored route small: at most ~400 points.
function thin(points, max = 400) {
  if (points.length <= max) return points.map(([a, b]) => [Number(a.toFixed(5)), Number(b.toFixed(5))]);
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out.map(([a, b]) => [Number(a.toFixed(5)), Number(b.toFixed(5))]);
}

const providers = {
  async ors(from, to) {
    const body = await request("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
      method: "POST",
      headers: { Authorization: process.env.ORS_API_KEY, "Content-Type": "application/json", Accept: "application/json, application/geo+json" },
      body: JSON.stringify({ coordinates: [[Number(from.lng), Number(from.lat)], [Number(to.lng), Number(to.lat)]] }),
    });
    const feature = body && body.features && body.features[0];
    if (!feature) throw new RoutingError("No road route was found between these points.", { noRoute: true });
    const summary = feature.properties && feature.properties.summary;
    return {
      meters: Number(summary && summary.distance),
      seconds: Number(summary && summary.duration),
      geometry: (feature.geometry.coordinates || []).map(([lng, lat]) => [lat, lng]),
    };
  },
  async osrm(from, to) {
    const base = String(process.env.OSRM_URL).replace(/\/+$/, "");
    const body = await request(`${base}/route/v1/driving/${Number(from.lng)},${Number(from.lat)};${Number(to.lng)},${Number(to.lat)}?overview=full&geometries=geojson`);
    const route = body && body.code === "Ok" && body.routes && body.routes[0];
    if (!route) throw new RoutingError("No road route was found between these points.", { noRoute: true });
    return {
      meters: Number(route.distance),
      seconds: Number(route.duration),
      geometry: (route.geometry.coordinates || []).map(([lng, lat]) => [lat, lng]),
    };
  },
  async google(from, to) {
    const body = await request("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: Number(from.lat), longitude: Number(from.lng) } } },
        destination: { location: { latLng: { latitude: Number(to.lat), longitude: Number(to.lng) } } },
        travelMode: "DRIVE",
      }),
    });
    const route = body && body.routes && body.routes[0];
    if (!route || !route.distanceMeters) throw new RoutingError("No road route was found between these points.", { noRoute: true });
    return {
      meters: Number(route.distanceMeters),
      seconds: Number(String(route.duration || "0").replace(/s$/, "")),
      geometry: route.polyline && route.polyline.encodedPolyline ? decodePolyline(route.polyline.encodedPolyline) : [],
    };
  },
};

const matrices = {
  async ors(sources, dests) {
    const locations = [...sources, ...dests].map((p) => [Number(p.lng), Number(p.lat)]);
    const body = await request("https://api.openrouteservice.org/v2/matrix/driving-car", {
      method: "POST",
      headers: { Authorization: process.env.ORS_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        locations,
        sources: sources.map((_, i) => i),
        destinations: dests.map((_, i) => sources.length + i),
        metrics: ["distance"],
      }),
    });
    return (body.distances || []).map((row) => row.map((m) => (m === null || m === undefined ? null : Number(m))));
  },
  async osrm(sources, dests) {
    const base = String(process.env.OSRM_URL).replace(/\/+$/, "");
    const coords = [...sources, ...dests].map((p) => `${Number(p.lng)},${Number(p.lat)}`).join(";");
    const src = sources.map((_, i) => i).join(";");
    const dst = dests.map((_, i) => sources.length + i).join(";");
    const body = await request(`${base}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=distance`);
    if (!body || body.code !== "Ok") throw new RoutingError(`Road-distance service error: ${(body && body.message) || "no answer"}`);
    return (body.distances || []).map((row) => row.map((m) => (m === null || m === undefined ? null : Number(m))));
  },
  async google(sources, dests) {
    const wp = (p) => ({ waypoint: { location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } } } });
    const body = await request("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,condition",
      },
      body: JSON.stringify({ origins: sources.map(wp), destinations: dests.map(wp), travelMode: "DRIVE" }),
    });
    const out = sources.map(() => dests.map(() => null));
    for (const cell of Array.isArray(body) ? body : []) {
      if (cell.condition === "ROUTE_EXISTS" && cell.distanceMeters !== undefined) {
        out[cell.originIndex || 0][cell.destinationIndex || 0] = Number(cell.distanceMeters);
      }
    }
    return out;
  },
};

function cached(k) {
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (hit) cache.delete(k);
  return undefined;
}
function remember(k, value) {
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  cache.set(k, { at: Date.now(), value });
}

async function route(from, to) {
  const name = provider();
  if (!name) throw new RoutingError(problem() || "Road distances are not available.");
  if (!validPoint(from) || !validPoint(to)) throw new RoutingError("A location is missing or not valid.");
  const k = `route:${name}:${key(from)}>${key(to)}`;
  const hit = cached(k);
  if (hit) return hit;
  const r = await providers[name](from, to);
  if (!Number.isFinite(r.meters) || r.meters <= 0) {
    if (key(from) === key(to)) throw new RoutingError("The pickup point and the delivery point are the same place.", { noRoute: true });
    throw new RoutingError("No road route was found between these points.", { noRoute: true });
  }
  const value = {
    km: Math.round(r.meters / 10) / 100,
    minutes: Number.isFinite(r.seconds) ? Math.max(1, Math.round(r.seconds / 60)) : null,
    geometry: thin(r.geometry || []),
    provider: name,
  };
  remember(k, value);
  return value;
}

// Road km from each source to each destination.
async function matrix(sources, dests) {
  const name = provider();
  if (!name) throw new RoutingError(problem() || "Road distances are not available.");
  if (!sources.length || !dests.length) return sources.map(() => dests.map(() => null));
  if (![...sources, ...dests].every(validPoint)) throw new RoutingError("A location is missing or not valid.");
  const k = `matrix:${name}:${sources.map(key).join("|")}>${dests.map(key).join("|")}`;
  const hit = cached(k);
  if (hit) return hit;
  const meters = await matrices[name](sources, dests);
  const value = sources.map((_, i) => dests.map((__, j) => {
    const m = meters[i] && meters[i][j];
    return m === null || m === undefined || !Number.isFinite(m) ? null : Math.round(m / 10) / 100;
  }));
  remember(k, value);
  return value;
}

module.exports = { provider, enabled, problem, route, matrix, RoutingError, decodePolyline, validPoint };
