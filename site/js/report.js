// Weather for one place on one day, from two independent sources:
//   1. Model data from Open-Meteo: ERA5 reanalysis (1940 to ~2 days ago) through
//      the archive API, and its forecast API for the last 90 days up to today.
//   2. What weather stations actually recorded: NOAA GHCN-Daily, via NCEI's
//      Access Data Service (records back to the 1800s in some places).
// Both are free, keyless and allow browser requests (CORS).

import { today, daysBetween } from './dates.js';

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const NCEI_SEARCH = 'https://www.ncei.noaa.gov/access/services/search/v1/data';
const NCEI_DATA = 'https://www.ncei.noaa.gov/access/services/data/v1';

export const MODEL_FIRST_DATE = '1940-01-01';
const FORECAST_DAYS_BACK = 85; // forecast API serves roughly the last 90 days

const DAILY = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'rain_sum',
  'snowfall_sum', 'sunshine_duration', 'wind_speed_10m_max', 'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
];
const HOURLY = ['temperature_2m', 'precipitation', 'snowfall', 'weather_code', 'cloud_cover'];

const memo = new Map();
function cached(key, fn) {
  if (!memo.has(key)) {
    const p = fn();
    memo.set(key, p);
    p.catch(() => memo.delete(key));
  }
  return memo.get(key);
}

// ---- model data (Open-Meteo) ---------------------------------------------------------

/** Resolves to null when the date is outside model coverage. */
export function modelDay(place, date) {
  if (date < MODEL_FIRST_DATE || date > today()) return Promise.resolve(null);
  return cached(`m|${place.lat}|${place.lon}|${date}`, () => fetchModelDay(place, date));
}

async function fetchModelDay(place, date) {
  const recent = daysBetween(date, today()) <= FORECAST_DAYS_BACK;
  const params = new URLSearchParams({
    latitude: place.lat, longitude: place.lon, start_date: date, end_date: date,
    daily: DAILY.join(','), hourly: HOURLY.join(','), timezone: 'auto',
  });
  let data = await getJson(`${recent ? FORECAST : ARCHIVE}?${params}`);
  if (data.error && !recent) data = await getJson(`${FORECAST}?${params}`); // archive lags a few days
  if (data.error) throw new Error(data.reason || 'weather data unavailable');

  const d = {};
  for (const k of DAILY) d[k] = data.daily?.[k]?.[0] ?? null;
  const hours = (data.hourly?.time || []).map((t, i) => ({
    hour: +t.slice(11, 13),
    temp: data.hourly.temperature_2m[i],
    precip: data.hourly.precipitation[i],
    snow: data.hourly.snowfall[i],
    code: data.hourly.weather_code[i],
    cloud: data.hourly.cloud_cover[i],
  }));
  return {
    source: recent ? 'forecast' : 'era5',
    timezone: data.timezone_abbreviation || data.timezone,
    elevation: data.elevation,
    code: d.weather_code,
    tmax: d.temperature_2m_max,
    tmin: d.temperature_2m_min,
    precip: d.precipitation_sum,
    rain: d.rain_sum,
    snow: d.snowfall_sum,                 // cm
    sunshineHours: d.sunshine_duration == null ? null : d.sunshine_duration / 3600,
    windMax: d.wind_speed_10m_max,        // km/h
    gustMax: d.wind_gusts_10m_max,
    windDir: d.wind_direction_10m_dominant,
    hours,
  };
}

// ---- station records (NOAA GHCN-Daily) -----------------------------------------------

const STATION_TYPES = ['TMAX', 'TMIN', 'PRCP', 'SNOW', 'SNWD',
  ...Array.from({ length: 22 }, (_, i) => `WT${String(i + 1).padStart(2, '0')}`)];

export const WEATHER_TYPES = {
  WT01: 'fog', WT02: 'heavy fog', WT03: 'thunder', WT04: 'sleet', WT05: 'hail',
  WT06: 'glaze or rime', WT07: 'blowing dust or sand', WT08: 'smoke or haze', WT09: 'blowing snow',
  WT10: 'tornado or waterspout', WT11: 'damaging winds', WT12: 'blowing spray', WT13: 'mist',
  WT14: 'drizzle', WT15: 'freezing drizzle', WT16: 'rain', WT17: 'freezing rain', WT18: 'snow',
  WT19: 'precipitation', WT21: 'ground fog', WT22: 'ice fog',
};

/** Up to `max` nearest stations with records for that day, nearest first. */
export function stationDay(place, date, max = 3) {
  return cached(`s|${place.lat}|${place.lon}|${date}`, () => fetchStations(place, date, max));
}

async function fetchStations(place, date, max) {
  for (const radius of [0.5, 1.5]) {
    const candidates = await nearbyStations(place, date, radius);
    if (!candidates.length) continue;
    const ids = candidates.slice(0, 10).map((s) => s.id);
    const params = new URLSearchParams({
      dataset: 'daily-summaries', stations: ids.join(','), startDate: date, endDate: date,
      dataTypes: STATION_TYPES.join(','), units: 'metric', format: 'json',
    });
    const rows = await getJson(`${NCEI_DATA}?${params}`);
    const byId = new Map(candidates.map((s) => [s.id, s]));
    const found = (Array.isArray(rows) ? rows : [])
      .map((r) => ({ ...byId.get(r.STATION), ...readStationRow(r) }))
      .filter((s) => s.id && (s.tmax != null || s.tmin != null || s.precip != null || s.snow != null))
      .sort((a, b) => a.km - b.km);
    if (found.length) return found.slice(0, max);
  }
  return [];
}

async function nearbyStations(place, date, radius) {
  const { lat, lon } = place;
  const bbox = [lat + radius, lon - radius, lat - radius, lon + radius].map((v) => v.toFixed(3)).join(',');
  const params = new URLSearchParams({
    dataset: 'daily-summaries', startDate: `${date}T00:00:00`, endDate: `${date}T23:59:59`,
    bbox, limit: '50',
  });
  const data = await getJson(`${NCEI_SEARCH}?${params}`);
  return (data.results || [])
    .map((r) => {
      const s = r.stations?.[0];
      const [slon, slat] = r.boundingPoints?.[0]?.coordinates || [];
      return s && slat != null ? { id: s.id, name: tidyName(s.name), lat: slat, lon: slon, km: distanceKm(lat, lon, slat, slon) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.km - b.km);
}

function readStationRow(r) {
  const num = (k) => (r[k] == null || r[k] === '' ? null : +r[k]);
  return {
    tmax: num('TMAX'), tmin: num('TMIN'),
    precip: num('PRCP'),                    // mm
    snow: num('SNOW') == null ? null : num('SNOW') / 10,    // mm -> cm
    snowDepth: num('SNWD') == null ? null : num('SNWD') / 10,
    types: Object.keys(WEATHER_TYPES).filter((k) => r[k] != null).map((k) => WEATHER_TYPES[k]),
  };
}

// "BURLINGTON INTERNATIONAL AIRPORT, VT US" -> "Burlington International Airport, VT"
function tidyName(name = '') {
  const [main, region = ''] = name.split(/,\s*/);
  const title = main.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
  const r = region.replace(/\s+US$/, '').trim();
  return r ? `${title}, ${r}` : title;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dlat = (lat2 - lat1) * rad, dlon = (lon2 - lon1) * rad;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- weather codes (WMO 4677 subset used by Open-Meteo) -------------------------------

const CODES = {
  0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Heavy freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Heavy freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '🌧️'],
  85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm with hail', '⛈️'], 99: ['Thunderstorm with heavy hail', '⛈️'],
};

export function describeCode(code) {
  const [text, icon] = CODES[code] || ['Unknown', '🌡️'];
  return { text, icon };
}

export function compass(deg) {
  if (deg == null) return '';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok && !body) throw new Error(`HTTP ${res.status}`);
  return body ?? {};
}
