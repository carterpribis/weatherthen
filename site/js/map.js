// The map: a MapLibre base map (OpenFreeMap "Positron", OpenStreetMap data) with the
// weather drawn into it.
//
// Layer order, bottom to top:
//   base map land, water and parks
//   weather colours (temperature or rain/snow), then the uncertainty veil
//   base map roads, rivers and borders
//   isobars
//   base map labels (towns, states, countries)
//   H/L pressure centres
//
// The weather grid is regular in latitude/longitude, but the map is Web Mercator, so
// the colour layers are painted into canvases whose rows are spaced in Mercator y.
// The canvases are then shown as MapLibre canvas sources covering the Mercator world
// (85.05°S to 85.05°N).

import * as maplibregl from '../vendor/maplibre-gl-6.18.0/maplibre-gl.mjs';
import {
  tempLut, tempIndex, VEIL_FROM, VEIL_TO, VEIL_MAX_ALPHA, precipIndex, rainRamp, snowRamp, frzRamp,
} from './colors.js';
import { sampleGrid } from './data.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const MERC_MAX_LAT = 85.051129;
const RASTER_W = 1440;           // 4 pixels per degree of longitude
const RASTER_H = 1440;           // square: the Mercator world is square
const ISOBAR_STEP = 4;           // hPa
const SMOOTH_PASSES = 2;         // light smoothing before contouring
const CONTOUR_OFFSET = 0.5;      // d3-contour puts value i at coordinate i + 0.5
const CONTOUR_UPSAMPLE = 2;      // trace isobars on a 2x finer interpolated grid (smoother curves;
                                 // 3x looks marginally better but costs ~150 ms a day during playback)
const EXTREMA_RADIUS = 5;        // grid cells: must be the lowest/highest within this
const EXTREMA_PROMINENCE = 5;    // hPa: and stand out this much within twice the radius
const MAX_CENTRES = 30;
const HOME = [-35, 30];          // lon, lat at the centre of the starting view
const MAX_ZOOM = 9;              // the weather grid is ~110 km; past this it's all base map

const CORNERS = [[-180, MERC_MAX_LAT], [180, MERC_MAX_LAT], [180, -MERC_MAX_LAT], [-180, -MERC_MAX_LAT]];
const EMPTY = { type: 'FeatureCollection', features: [] };

export class WeatherMap {
  constructor(container, manifest) {
    this.container = container;
    this.g = manifest.grid;
    this.day = null;
    this.detail = null;
    this.layer = 'temp';          // 'temp' or 'precip'
    this.showUncertainty = false;
    this.veilFor = null;
    this.onChange = null;          // called after the view moves
    this.hoverFn = null;
    this.pickFn = null;
    this.marker = null;

    this.raster = makeCanvas(RASTER_W, RASTER_H);
    this.precipRaster = makeCanvas(RASTER_W, RASTER_H);
    this.veil = makeCanvas(RASTER_W, RASTER_H);
    this.sampler = mercatorSampler(this.g);

    this.map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: HOME,
      zoom: this.homeZoom(),
      minZoom: 0,
      maxZoom: MAX_ZOOM,
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,   // credited in the page footer instead
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();

    this.ready = new Promise((resolve, reject) => {
      this.map.once('load', () => { this.addWeatherLayers(); resolve(); });
      this.map.once('error', (e) => { if (!this.map.loaded()) reject(e.error || new Error('map failed to load')); });
    });

    this.map.on('move', () => this.onChange?.());
    this.map.on('mousemove', (e) => this.hoverFn?.([e.lngLat.lng, e.lngLat.lat], e.point));
    this.map.on('mouseout', () => this.hoverFn?.(null, null));
    this.map.on('click', (e) => this.pickFn?.(e.lngLat.lng, e.lngLat.lat));
  }

  onHover(fn) { this.hoverFn = fn; }
  onPick(fn) { this.pickFn = fn; }

  // ---- layers ------------------------------------------------------------------------

  addWeatherLayers() {
    const map = this.map;
    const layers = map.getStyle().layers;
    // Weather colours go above land/water fills, below roads, rivers, borders and labels.
    const firstLine = layers.find((l) => l.type === 'line' || l.type === 'symbol')?.id;
    const firstLabel = layers.find((l) => l.type === 'symbol')?.id;

    const canvasSource = (canvas) => ({ type: 'canvas', canvas, coordinates: CORNERS, animate: false });
    map.addSource('wx-temp', canvasSource(this.raster));
    map.addSource('wx-precip', canvasSource(this.precipRaster));
    map.addSource('wx-veil', canvasSource(this.veil));
    const raster = (id, source, opacity) => ({
      id, type: 'raster', source,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
    });
    map.addLayer(raster('wx-temp', 'wx-temp', 0.72), firstLine);
    map.addLayer(raster('wx-precip', 'wx-precip', 0.9), firstLine);
    map.addLayer(raster('wx-veil', 'wx-veil', 1), firstLine);

    map.addSource('wx-isobars', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'wx-isobars-halo', type: 'line', source: 'wx-isobars',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': ['case', ['get', 'major'], 3.6, 2.8] },
    }, firstLabel);
    map.addLayer({
      id: 'wx-isobars', type: 'line', source: 'wx-isobars',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#15161c', 'line-opacity': 0.85, 'line-width': ['case', ['get', 'major'], 1.9, 1.1] },
    }, firstLabel);

    map.addSource('wx-centres', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'wx-centres', type: 'symbol', source: 'wx-centres',
      layout: {
        'text-field': ['format',
          ['get', 'kind'], { 'font-scale': 1 },
          '\n', {},
          ['to-string', ['get', 'value']], { 'font-scale': 0.55, 'text-color': '#15161c' }],
        'text-font': ['Noto Sans Bold'],
        'text-size': 22,
        'text-line-height': 0.95,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['match', ['get', 'kind'], 'L', '#b3122e', '#123fa8'],
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 2,
      },
    });

    // Make state and country borders a little stronger over the weather colours.
    for (const [id, color] of [['boundary_3', 'rgba(70,72,84,0.55)'], ['boundary_2', 'rgba(45,46,56,0.75)']]) {
      if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', color);
    }
    // ...and roads and railways a little quieter, so they don't compete with the weather.
    for (const l of layers) {
      if (l.type === 'line' && /^(highway|road|railway|tunnel|bridge)/.test(l.id)) {
        map.setPaintProperty(l.id, 'line-opacity', 0.55);
      }
    }
    this.layersReady = true;
    this.refresh();
  }

  /** Show or hide layers to match the current day, colour layer and uncertainty setting. */
  refresh() {
    if (!this.layersReady) return;
    const map = this.map;
    const has = !!this.day;
    const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    vis('wx-temp', has && this.layer === 'temp');
    vis('wx-precip', has && this.layer === 'precip' && !!this.detail);
    const veil = has && this.showUncertainty && !!this.day.fields.prmsl_spread;
    if (veil && this.veilFor !== this.day) {
      this.paintMulti(this.veil, [this.day.fields.prmsl_spread], veilPixel);
      this.veilFor = this.day;
      pushCanvas(map, 'wx-veil');
    }
    vis('wx-veil', veil);
    if (!has) {
      map.getSource('wx-isobars').setData(EMPTY);
      map.getSource('wx-centres').setData(EMPTY);
    }
  }

  // ---- data ----------------------------------------------------------------------------

  /** Map fields for a day, plus (optionally) its detail fields for the rain/snow layer. */
  setDay(day, detail = null) {
    this.day = day;
    this.veilFor = null;
    this.paintMulti(this.raster, [day.fields.t2m], temperaturePixel);
    const p = smooth(day.fields.prmsl, this.g.nx, this.g.ny, SMOOTH_PASSES);
    const isobars = this.buildIsobars(p);
    const centres = this.findCentres(p, day.fields.prmsl_spread);
    this.detail = null;
    if (detail) this.paintDetail(detail);
    if (!this.layersReady) return;
    pushCanvas(this.map, 'wx-temp');
    if (this.detail) pushCanvas(this.map, 'wx-precip');
    this.map.getSource('wx-isobars').setData(isobars);
    this.map.getSource('wx-centres').setData(centres);
    this.refresh();
  }

  /** Detail fields arriving after the day (e.g. when switching to the rain/snow layer). */
  setDetail(detail) {
    if (!this.day || detail.date !== this.day.date) return;
    this.paintDetail(detail);
    if (this.layersReady) pushCanvas(this.map, 'wx-precip');
    this.refresh();
  }

  paintDetail(detail) {
    this.detail = detail;
    const f = detail.fields;
    this.paintMulti(this.precipRaster, [f.precip, f.snow_frac, f.frz_frac], precipPixel);
  }

  /** No map data for the current date: just the base map. */
  clearDay() {
    this.day = null;
    this.detail = null;
    this.veilFor = null;
    this.refresh();
  }

  setLayer(layer) {
    this.layer = layer;
    this.refresh();
  }

  setUncertainty(on) {
    this.showUncertainty = on;
    this.refresh();
  }

  /** Bilinear value of every map field (and detail field, if loaded) at (lon, lat). */
  sample(lon, lat) {
    if (!this.day) return null;
    const out = sampleGrid(this.g, this.day.fields, lon, lat);
    if (this.detail) Object.assign(out, sampleGrid(this.g, this.detail.fields, lon, lat));
    return out;
  }

  // Paint a canvas in Mercator rows from one or more grid fields (bilinear).
  paintMulti(canvas, fields, pixel) {
    const { nx } = this.g;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(RASTER_W, RASTER_H);
    const d = img.data;
    const { i0, i1, fx, r0, r1, fy } = this.sampler;
    const k = fields.length;
    const vals = new Float64Array(k);
    for (let q = 0; q < RASTER_H; q++) {
      const ra = r0[q] * nx, rb = r1[q] * nx, wy = fy[q];
      for (let p = 0; p < RASTER_W; p++) {
        const a0 = ra + i0[p], a1 = ra + i1[p], b0 = rb + i0[p], b1 = rb + i1[p], w = fx[p];
        for (let m = 0; m < k; m++) {
          const f = fields[m];
          const a = f[a0] + (f[a1] - f[a0]) * w;
          const b = f[b0] + (f[b1] - f[b0]) * w;
          vals[m] = a + (b - a) * wy;
        }
        pixel(d, (q * RASTER_W + p) * 4, vals);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Isobars as GeoJSON lines in lon/lat (MapLibre projects them). */
  buildIsobars(p) {
    const { nx, ny, lon0, lat0, dlon, dlat } = this.g;
    // Contour a grid interpolated to CONTOUR_UPSAMPLE x the resolution, so lines curve
    // smoothly when zoomed in. The extra column repeats the first one so lines join
    // across the date line.
    const U = CONTOUR_UPSAMPLE;
    const w = nx * U + 1, h = (ny - 1) * U + 1;
    const ext = new Float64Array(w * h);
    for (let jj = 0; jj < h; jj++) {
      const v = jj / U, j0 = Math.floor(v), j1 = Math.min(j0 + 1, ny - 1), fy = v - j0;
      for (let ii = 0; ii < w; ii++) {
        const u = ii / U, i0 = Math.floor(u) % nx, i1 = (i0 + 1) % nx, fx = u - Math.floor(u);
        const a = p[j0 * nx + i0] + (p[j0 * nx + i1] - p[j0 * nx + i0]) * fx;
        const b = p[j1 * nx + i0] + (p[j1 * nx + i1] - p[j1 * nx + i0]) * fx;
        ext[jj * w + ii] = a + (b - a) * fy;
      }
    }
    const [lo, hi] = d3.extent(ext);
    const levels = d3.range(Math.ceil(lo / ISOBAR_STEP) * ISOBAR_STEP, hi, ISOBAR_STEP);
    const eps = 1e-6;
    const onEdge = (a, b) =>
      (a[0] <= eps && b[0] <= eps) || (a[0] >= w - eps && b[0] >= w - eps) ||
      (a[1] <= eps && b[1] <= eps) || (a[1] >= h - eps && b[1] >= h - eps);
    const toLonLat = (pt) => [
      Math.min(180, Math.max(-180, lon0 + ((pt[0] - CONTOUR_OFFSET) / U) * dlon)),
      Math.min(90, Math.max(-90, lat0 + ((pt[1] - CONTOUR_OFFSET) / U) * dlat)),
    ];
    const features = [];
    for (const c of d3.contours().size([w, h]).thresholds(levels)(ext)) {
      const lines = [];
      for (const polygon of c.coordinates) {
        for (const ring of polygon) {
          let line = null;
          for (let k = 1; k < ring.length; k++) {
            const a = ring[k - 1], b = ring[k];
            if (onEdge(a, b)) { line = null; continue; } // skip the grid border
            if (!line) { line = [toLonLat(a)]; lines.push(line); }
            line.push(toLonLat(b));
          }
        }
      }
      if (lines.length) {
        features.push({
          type: 'Feature',
          properties: { value: c.value, major: c.value % 20 === 0 },
          geometry: { type: 'MultiLineString', coordinates: lines.filter((l) => l.length > 1) },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  // Pressure centres: local extremes that stand out from their surroundings.
  findCentres(p, spread) {
    const { nx, ny, lon0, lat0, dlon, dlat } = this.g;
    const R = EXTREMA_RADIUS, R2 = 2 * R;
    const at = (i, j) => p[Math.min(Math.max(j, 0), ny - 1) * nx + ((i % nx) + nx) % nx];
    const found = [];
    for (let j = 0; j < ny; j++) {
      const lat = lat0 + j * dlat;
      if (Math.abs(lat) > 75) continue;
      for (let i = 0; i < nx; i++) {
        const v = p[j * nx + i];
        let isMin = true, isMax = true;
        for (let dj = -R; dj <= R && (isMin || isMax); dj++) {
          for (let di = -R; di <= R; di++) {
            if (!di && !dj) continue;
            const o = at(i + di, j + dj);
            // Ties: only the first cell in scan order counts.
            const before = dj < 0 || (dj === 0 && di < 0);
            if (o < v || (o === v && before)) isMin = false;
            if (o > v || (o === v && before)) isMax = false;
          }
        }
        if (!isMin && !isMax) continue;
        let lo = Infinity, hi = -Infinity;
        for (let dj = -R2; dj <= R2; dj++) {
          for (let di = -R2; di <= R2; di++) {
            const o = at(i + di, j + dj);
            if (o < lo) lo = o;
            if (o > hi) hi = o;
          }
        }
        const prominence = isMin ? hi - v : v - lo;
        if (prominence < EXTREMA_PROMINENCE) continue;
        found.push({ kind: isMin ? 'L' : 'H', lon: lon0 + i * dlon, lat, prominence, value: Math.round(v),
          spread: spread ? spread[j * nx + i] : NaN });
      }
    }
    const top = found.sort((a, b) => b.prominence - a.prominence).slice(0, MAX_CENTRES);
    return {
      type: 'FeatureCollection',
      features: top.map((c) => ({
        type: 'Feature',
        properties: { kind: c.kind, value: c.value },
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      })),
    };
  }

  // ---- view ------------------------------------------------------------------------------

  homeZoom() {
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 600;
    // Show roughly the whole width of the world, but never leave empty bands above/below.
    return Math.max(Math.log2(w / 512), Math.log2(h / 512), 0.3);
  }

  /** Screen point -> [lon, lat]. */
  toLonLat(x, y) {
    const ll = this.map.unproject([x, y]);
    return Math.abs(ll.lat) > 90 ? null : [ll.lng, ll.lat];
  }

  /** Animate to (lon, lat) at a MapLibre zoom level; padding keeps it clear of panels. */
  flyTo(lon, lat, zoom, padding) {
    this.map.flyTo({ center: [lon, lat], zoom, padding: padding || 0, duration: 1100, essential: true });
  }

  jumpTo(lon, lat, zoom, padding) {
    this.map.jumpTo({ center: [lon, lat], zoom, padding: padding || 0 });
  }

  resetView() {
    this.map.flyTo({ center: HOME, zoom: this.homeZoom(), padding: 0, duration: 800 });
  }

  setMarker(lonlat) {
    if (!lonlat) {
      this.marker?.remove();
      this.marker = null;
      return;
    }
    if (!this.marker) this.marker = new maplibregl.Marker({ color: '#f2c14e' });
    this.marker.setLngLat(lonlat).addTo(this.map);
  }
}

// ---- helpers ---------------------------------------------------------------------------------

// Tell MapLibre a static canvas source has new pixels: upload on the next frame, then stop.
function pushCanvas(map, id) {
  const src = map.getSource(id);
  if (!src) return;
  src.play();
  map.triggerRepaint();
  map.once('render', () => src.pause());
}

function temperaturePixel(d, o, v) {
  const t = v[0];
  if (Number.isNaN(t)) { d[o + 3] = 0; return; }
  const k = tempIndex(t) * 3;
  d[o] = tempLut[k]; d[o + 1] = tempLut[k + 1]; d[o + 2] = tempLut[k + 2]; d[o + 3] = 255;
}

function precipPixel(d, o, v) {
  const [mm, snow, frz] = v;
  const k = precipIndex(mm);
  if (k < 0) { d[o + 3] = 0; return; }
  const i = k * 3;
  if (frz >= 0.25) {
    d[o] = frzRamp[i]; d[o + 1] = frzRamp[i + 1]; d[o + 2] = frzRamp[i + 2];
  } else {
    const t = Math.min(Math.max((snow - 0.15) / 0.45, 0), 1); // 15% snow -> 60% snow
    d[o] = rainRamp[i] + (snowRamp[i] - rainRamp[i]) * t;
    d[o + 1] = rainRamp[i + 1] + (snowRamp[i + 1] - rainRamp[i + 1]) * t;
    d[o + 2] = rainRamp[i + 2] + (snowRamp[i + 2] - rainRamp[i + 2]) * t;
  }
  // Light amounts stay see-through (the reanalysis drizzles too often); 5 mm+ is solid.
  d[o + 3] = Math.round((0.3 + 0.62 * Math.min(1, Math.max(0, (mm - 1) / 4))) * Math.min(1, (mm - 0.5) * 2) * 255);
}

function veilPixel(d, o, v) {
  const s = v[0];
  const f = Math.min(Math.max((s - VEIL_FROM) / (VEIL_TO - VEIL_FROM), 0), 1);
  d[o] = 24; d[o + 1] = 26; d[o + 2] = 34;
  d[o + 3] = Number.isNaN(s) ? 0 : Math.round(f * VEIL_MAX_ALPHA * 255);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Which grid cells each raster pixel blends: columns evenly spaced in longitude,
// rows evenly spaced in Mercator y.
function mercatorSampler(g) {
  const { nx, ny, lon0, lat0, dlon, dlat } = g;
  const i0 = new Int32Array(RASTER_W), i1 = new Int32Array(RASTER_W), fx = new Float32Array(RASTER_W);
  for (let p = 0; p < RASTER_W; p++) {
    const lon = -180 + (p + 0.5) * 360 / RASTER_W;
    let u = (lon - lon0) / dlon;
    u = ((u % nx) + nx) % nx;
    i0[p] = Math.floor(u);
    i1[p] = (i0[p] + 1) % nx;
    fx[p] = u - i0[p];
  }
  const r0 = new Int32Array(RASTER_H), r1 = new Int32Array(RASTER_H), fy = new Float32Array(RASTER_H);
  for (let q = 0; q < RASTER_H; q++) {
    const y = (q + 0.5) / RASTER_H;                                   // 0 = north edge
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
    const v = Math.min(Math.max((lat - lat0) / dlat, 0), ny - 1);
    r0[q] = Math.floor(v);
    r1[q] = Math.min(r0[q] + 1, ny - 1);
    fy[q] = v - r0[q];
  }
  return { i0, i1, fx, r0, r1, fy };
}

// 1-2-1 smoothing, wrapping in longitude.
function smooth(src, nx, ny, passes) {
  let a = Float64Array.from(src);
  const b = new Float64Array(a.length);
  for (let n = 0; n < passes; n++) {
    for (let j = 0; j < ny; j++) {
      const r = j * nx;
      for (let i = 0; i < nx; i++) {
        b[r + i] = (a[r + (i + nx - 1) % nx] + 2 * a[r + i] + a[r + (i + 1) % nx]) / 4;
      }
    }
    for (let j = 0; j < ny; j++) {
      const up = Math.max(j - 1, 0) * nx, r = j * nx, dn = Math.min(j + 1, ny - 1) * nx;
      for (let i = 0; i < nx; i++) a[r + i] = (b[up + i] + 2 * b[r + i] + b[dn + i]) / 4;
    }
  }
  return a;
}
