// Loading the manifest and per-day grid files built by pipeline/build_days.py.
// The day-file format and manifest v4 layout are documented at the top of that
// script; keep both in sync.
//
// Manifest v4: sources (20CR, later ERA5 and GFS), each with its own fields, file
// paths and date ranges; `priority` says which wins if ranges overlap.

import { DATA_ROOT } from './config.js';

const CACHE_SIZE = 80;
const cache = new Map(); // 'map|date' or 'detail|date' -> Promise<Day>, oldest first

export async function loadManifest() {
  const res = await fetch(DATA_ROOT + 'manifest.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  const m = await res.json();
  if (m.version !== 4) throw new Error(`unsupported manifest version ${m.version}`);
  return m;
}

/** The source that has a map for this date: {id, ...source} or null. */
export function sourceFor(manifest, date) {
  for (const id of manifest.priority) {
    const src = manifest.sources[id];
    if (src.ranges.some((r) => date >= r.start && date <= r.end)) return { id, ...src };
  }
  return null;
}

export function hasMap(manifest, date) {
  return !!sourceFor(manifest, date);
}

/** Human summary of map coverage, e.g. "1836–1840, 1888". */
export function coverageLabel(manifest) {
  const ranges = Object.values(manifest.sources).flatMap((s) => s.ranges)
    .map((r) => [+r.start.slice(0, 4), +r.end.slice(0, 4)])
    .sort((a, b) => a[0] - b[0]);
  const runs = [];
  for (const [a, b] of ranges) {
    const last = runs.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else runs.push([a, b]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/** Map fields for a day: Promise<{date, fields: {id: Float32Array}}>, cached. */
export function loadDay(manifest, date) {
  const src = sourceFor(manifest, date);
  if (!src) return Promise.reject(new Error(`no map for ${date}`));
  return cachedLoad(`map|${date}`, () => fetchGrid(manifest, src.map.path, src.map.fields, date, src.id));
}

/** Detail fields (rain, snow, cloud, wind, highs/lows) for a day, same shape. */
export function loadDetail(manifest, date) {
  const src = sourceFor(manifest, date);
  if (!src?.detail) return Promise.reject(new Error(`no detail data for ${date}`));
  return cachedLoad(`detail|${date}`, () => fetchGrid(manifest, src.detail.path, src.detail.fields, date, src.id));
}

/** Bilinear value of every field in `fields` at (lon, lat). */
export function sampleGrid(grid, fields, lon, lat) {
  const { nx, ny, lon0, lat0, dlon, dlat } = grid;
  let u = (lon - lon0) / dlon;
  u = ((u % nx) + nx) % nx;
  const v = Math.min(Math.max((lat - lat0) / dlat, 0), ny - 1);
  const i0 = Math.floor(u), i1 = (i0 + 1) % nx, fx = u - i0;
  const j0 = Math.floor(v), j1 = Math.min(j0 + 1, ny - 1), fy = v - j0;
  const out = {};
  for (const [id, a] of Object.entries(fields)) {
    const top = a[j0 * nx + i0] * (1 - fx) + a[j0 * nx + i1] * fx;
    const bot = a[j1 * nx + i0] * (1 - fx) + a[j1 * nx + i1] * fx;
    out[id] = top * (1 - fy) + bot * fy;
  }
  return out;
}

function cachedLoad(key, fn) {
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = fn();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return p;
}

async function fetchGrid(manifest, pathTemplate, fieldList, date, source) {
  const url = DATA_ROOT + pathTemplate.replace('{year}', date.slice(0, 4)).replace('{date}', date);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${date}: HTTP ${res.status}`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  // Some servers decompress .gz on the way (Content-Encoding); only gunzip if still gzipped.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Undo the byte shuffle: N high bytes, then N low bytes.
  const n = bytes.length >> 1;
  const { nx, ny } = manifest.grid;
  const size = nx * ny;
  if (n !== size * fieldList.length) throw new Error(`${date}: unexpected file size`);

  const fields = {};
  fieldList.forEach((f, k) => {
    const out = new Float32Array(size);
    const base = k * size;
    for (let i = 0; i < size; i++) {
      const s = ((bytes[base + i] << 8) | bytes[n + base + i]) << 16 >> 16; // to signed int16
      out[i] = s === manifest.nodata ? NaN : s * f.scale + f.offset;
    }
    fields[f.id] = out;
  });
  return { date, source, fields };
}
