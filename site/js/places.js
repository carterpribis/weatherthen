// Place search via Open-Meteo's geocoding API (GeoNames data, no key needed).

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const cache = new Map();

/** Returns [{name, label, lat, lon, country, countryCode, timezone}] */
export async function searchPlaces(query, signal) {
  const q = query.trim();
  const coords = parseCoords(q);
  if (coords) return [coords];
  if (q.length < 2) return [];
  if (cache.has(q.toLowerCase())) return cache.get(q.toLowerCase());

  const url = `${GEOCODE}?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status})`);
  const data = await res.json();
  const places = (data.results || []).map((r) => ({
    name: r.name,
    label: [r.name, r.admin1 !== r.name ? r.admin1 : null, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
    country: r.country,
    countryCode: r.country_code,
  }));
  cache.set(q.toLowerCase(), places);
  return places;
}

/** A point picked on the map, or typed as "lat, lon". */
export function pointPlace(lat, lon) {
  const label = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  return { name: label, label, lat: round(lat), lon: round(lon), country: null, countryCode: null };
}

function parseCoords(q) {
  const m = q.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? pointPlace(lat, lon) : null;
}

const round = (v) => Math.round(v * 1e4) / 1e4;
