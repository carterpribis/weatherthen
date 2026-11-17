// Canvas map: temperature or rain/snow colours, uncertainty veil, coastlines, isobars,
// H/L centres.
//
// World coordinates are plain degrees: x = longitude, y = -latitude. The map is
// equirectangular, so a linear canvas transform maps world -> screen, and the
// 1° data grid can be drawn as an image without reprojection.

import {
  tempLut, tempIndex, VEIL_FROM, VEIL_TO, VEIL_MAX_ALPHA, precipIndex, rainRamp, snowRamp, frzRamp,
} from './colors.js';
import { sampleGrid } from './data.js';

const UPSAMPLE = 4;              // raster pixels per grid cell
const ISOBAR_STEP = 4;           // hPa
const SMOOTH_PASSES = 2;         // light smoothing before contouring
const CONTOUR_OFFSET = 0.5;      // d3-contour puts value i at coordinate i + 0.5
const EXTREMA_RADIUS = 5;        // grid cells: must be the lowest/highest within this
const EXTREMA_PROMINENCE = 5;    // hPa: and stand out this much within twice the radius
const MAX_CENTRES = 30;
const HOME = [-35, 30];          // lon, lat at the centre of the starting view

export class WeatherMap {
  constructor(canvas, manifest, land) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.g = manifest.grid;
    this.transform = d3.zoomIdentity;
    this.day = null;
    this.showUncertainty = false;
    this.layer = 'temp';           // 'temp' or 'precip'
    this.detail = null;
    this.onChange = null;          // called after pan/zoom
    this.pending = false;

    this.coast = worldPath(topojson.feature(land, land.objects.land));
    this.graticule = worldPath(d3.geoGraticule().step([30, 30])());

    const { nx, ny } = this.g;
    this.rw = nx * UPSAMPLE;
    this.rh = (ny - 1) * UPSAMPLE + 1;
    this.raster = makeCanvas(this.rw, this.rh);
    this.veil = makeCanvas(this.rw, this.rh);
    this.precipRaster = makeCanvas(this.rw, this.rh);
    this.veilFor = null;
    this.cols = columnSampler(nx, UPSAMPLE, this.rw);

    this.zoom = d3.zoom()
      .scaleExtent([1, 24])
      .on('zoom', (e) => {
        this.transform = e.transform;
        this.requestDraw();
        this.onChange?.();
      });
    d3.select(canvas).call(this.zoom);

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  // ---- view ----------------------------------------------------------------

  resize() {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (!W || !H) return;
    this.W = W; this.H = H;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(W * this.dpr);
    this.canvas.height = Math.round(H * this.dpr);
    // Cover the screen: the map is at least as tall and as wide as the window.
    this.s0 = Math.max(W / 360, H / 180);
    const hw = 180 * this.s0, hh = 90 * this.s0;
    this.zoom
      .extent([[0, 0], [W, H]])
      .translateExtent([[W / 2 - hw, H / 2 - hh], [W / 2 + hw, H / 2 + hh]]);
    const first = !this.sized;
    this.sized = true;
    d3.select(this.canvas).call(this.zoom.transform, this.clamp(first ? this.home() : this.transform));
    this.draw();
  }

  /** Keep a transform inside the map edges (zoom.transform doesn't do this itself). */
  clamp(t) {
    return this.zoom.constrain()(t, [[0, 0], [this.W, this.H]], this.zoom.translateExtent());
  }

  /** Starting view: whole-map zoom, centred on the Atlantic. */
  home() {
    const bx = this.s0 * HOME[0] + this.W / 2, by = -this.s0 * HOME[1] + this.H / 2;
    return this.clamp(d3.zoomIdentity.translate(this.W / 2 - bx, this.H / 2 - by));
  }

  /** Screen point -> [lon, lat], or null outside the world. */
  toLonLat(x, y) {
    const t = this.transform;
    const lon = (t.invertX(x) - this.W / 2) / this.s0;
    const lat = -(t.invertY(y) - this.H / 2) / this.s0;
    return lon < -180 || lon > 180 || lat < -90 || lat > 90 ? null : [lon, lat];
  }

  toScreen(lon, lat) {
    const t = this.transform;
    return [t.applyX(this.s0 * lon + this.W / 2), t.applyY(-this.s0 * lat + this.H / 2)];
  }

  /** Animate so (lon, lat) sits at screen point `at` (default: centre) at zoom k (1 = whole map). */
  flyTo(lon, lat, k, at) {
    d3.select(this.canvas).transition().duration(900).call(this.zoom.transform, this.viewAt(lon, lat, k, at));
  }

  jumpTo(lon, lat, k, at) {
    d3.select(this.canvas).call(this.zoom.transform, this.viewAt(lon, lat, k, at));
  }

  viewAt(lon, lat, k, at = [this.W / 2, this.H / 2]) {
    const bx = this.s0 * lon + this.W / 2, by = -this.s0 * lat + this.H / 2;
    return this.clamp(d3.zoomIdentity.translate(at[0], at[1]).scale(k).translate(-bx, -by));
  }

  resetView() {
    d3.select(this.canvas).transition().duration(700).call(this.zoom.transform, this.home());
  }

  // ---- data ----------------------------------------------------------------

  /** Map fields for a day, plus (optionally) its detail fields for the rain/snow layer. */
  setDay(day, detail = null) {
    this.day = day;
    this.paintRaster(this.raster, day.fields.t2m, temperaturePixel);
    this.veilFor = null;
    const p = smooth(day.fields.prmsl, this.g.nx, this.g.ny, SMOOTH_PASSES);
    this.isobars = this.buildIsobars(p);
    this.centres = this.findCentres(p, day.fields.prmsl_spread);
    this.detail = null;
    if (detail) this.paintDetail(detail);
    this.draw();
  }

  /** Detail fields arriving after the day (e.g. when switching to the rain/snow layer). */
  setDetail(detail) {
    if (!this.day || detail.date !== this.day.date) return;
    this.paintDetail(detail);
    this.draw();
  }

  paintDetail(detail) {
    this.detail = detail;
    const f = detail.fields;
    this.paintMulti(this.precipRaster, [f.precip, f.snow_frac, f.frz_frac], precipPixel);
  }

  setLayer(layer) {
    this.layer = layer;
    this.draw();
  }

  /** No map data for the current date: show coastlines on a plain background. */
  clearDay() {
    this.day = null;
    this.detail = null;
    this.veilFor = null;
    this.draw();
  }

  setUncertainty(on) {
    this.showUncertainty = on;
    this.draw();
  }

  /** Bilinear value of every map field (and detail field, if loaded) at (lon, lat). */
  sample(lon, lat) {
    if (!this.day) return null;
    const out = sampleGrid(this.g, this.day.fields, lon, lat);
    if (this.detail) Object.assign(out, sampleGrid(this.g, this.detail.fields, lon, lat));
    return out;
  }

  // Upsample a grid field into an offscreen canvas, colouring each pixel.
  paintRaster(canvas, field, pixel) {
    this.paintMulti(canvas, [field], (d, o, v) => pixel(d, o, v[0]));
  }

  // Same, for a colour that depends on several fields at once.
  paintMulti(canvas, fields, pixel) {
    const { nx, ny } = this.g;
    const { rw, rh } = this;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(rw, rh);
    const d = img.data;
    const { i0, i1, fx } = this.cols;
    const k = fields.length;
    const vals = new Float64Array(k);
    for (let q = 0; q < rh; q++) {
      const v = q / UPSAMPLE;
      const j0 = Math.floor(v), j1 = Math.min(j0 + 1, ny - 1), fy = v - j0;
      const r0 = j0 * nx, r1 = j1 * nx;
      for (let p = 0; p < rw; p++) {
        const a0 = r0 + i0[p], a1 = r0 + i1[p], b0 = r1 + i0[p], b1 = r1 + i1[p], w = fx[p];
        for (let m = 0; m < k; m++) {
          const f = fields[m];
          const a = f[a0] + (f[a1] - f[a0]) * w;
          const b = f[b0] + (f[b1] - f[b0]) * w;
          vals[m] = a + (b - a) * fy;
        }
        pixel(d, (q * rw + p) * 4, vals);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  buildIsobars(p) {
    const { nx, ny, lon0, lat0, dlon, dlat } = this.g;
    // Repeat the first column at the end so lines join across the date line.
    const w = nx + 1;
    const ext = new Float64Array(w * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < w; i++) ext[j * w + i] = p[j * nx + (i % nx)];
    const [lo, hi] = d3.extent(ext);
    const levels = d3.range(Math.ceil(lo / ISOBAR_STEP) * ISOBAR_STEP, hi, ISOBAR_STEP);
    const minor = new Path2D(), major = new Path2D();
    const eps = 1e-6;
    const onEdge = (a, b) =>
      (a[0] <= eps && b[0] <= eps) || (a[0] >= w - eps && b[0] >= w - eps) ||
      (a[1] <= eps && b[1] <= eps) || (a[1] >= ny - eps && b[1] >= ny - eps);
    const toWorld = (pt) => [lon0 + (pt[0] - CONTOUR_OFFSET) * dlon, -(lat0 + (pt[1] - CONTOUR_OFFSET) * dlat)];

    for (const c of d3.contours().size([w, ny]).thresholds(levels)(ext)) {
      const path = c.value % 20 === 0 ? major : minor;
      for (const polygon of c.coordinates) {
        for (const ring of polygon) {
          let drawing = false;
          for (let k = 1; k < ring.length; k++) {
            const a = ring[k - 1], b = ring[k];
            if (onEdge(a, b)) { drawing = false; continue; } // skip the grid border
            if (!drawing) { path.moveTo(...toWorld(a)); drawing = true; }
            path.lineTo(...toWorld(b));
          }
        }
      }
    }
    return { minor, major };
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
        found.push({
          kind: isMin ? 'L' : 'H', lon: lon0 + i * dlon, lat, prominence,
          value: v, spread: spread ? spread[j * nx + i] : NaN,
        });
      }
    }
    return found.sort((a, b) => b.prominence - a.prominence).slice(0, MAX_CENTRES);
  }

  // ---- drawing ---------------------------------------------------------------

  requestDraw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.draw(); });
  }

  draw() {
    const { ctx, dpr, W, H, g } = this;
    if (!W) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue('--map-bg') || '#0b0e13';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // world -> screen as one canvas transform
    const t = this.transform;
    const a = t.k * this.s0;
    const e = t.x + t.k * W / 2, f = t.y + t.k * H / 2;
    ctx.setTransform(dpr * a, 0, 0, dpr * a, dpr * e, dpr * f);
    const px = 1 / a; // one screen pixel in world units

    if (this.day) {
      const x0 = g.lon0 - 0.5 * g.dlon / UPSAMPLE;
      const y0 = -g.lat0 - 0.5 * Math.abs(g.dlat) / UPSAMPLE;
      const w = this.rw * g.dlon / UPSAMPLE, h = this.rh * Math.abs(g.dlat) / UPSAMPLE;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (this.layer === 'precip') {
        // Newspaper-style base: pale sea, light grey land, then rain and snow on top.
        ctx.fillStyle = '#eef1f4';
        ctx.fillRect(-180, -90, 360, 180);
        ctx.fillStyle = '#d3d8df';
        ctx.fill(this.coast);
        if (this.detail) ctx.drawImage(this.precipRaster, x0, y0, w, h);
      } else {
        ctx.drawImage(this.raster, x0, y0, w, h);
      }
      if (this.showUncertainty && this.day.fields.prmsl_spread) {
        if (this.veilFor !== this.day) {
          this.paintRaster(this.veil, this.day.fields.prmsl_spread, veilPixel);
          this.veilFor = this.day;
        }
        ctx.drawImage(this.veil, x0, y0, w, h);
      }
    } else {
      ctx.fillStyle = '#2a313d';
      ctx.fillRect(-180, -90, 360, 180);
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const light = this.day && this.layer === 'precip';
    ctx.strokeStyle = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 0.6 * px;
    ctx.stroke(this.graticule);

    ctx.strokeStyle = !this.day ? 'rgba(200,210,225,0.55)' : light ? 'rgba(70,78,92,0.75)' : 'rgba(14,16,24,0.85)';
    ctx.lineWidth = 1.1 * px;
    ctx.stroke(this.coast);

    if (this.day) {
      const { minor, major } = this.isobars;
      // A faint light halo lifts the lines off busy colours without doubling them.
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2.6 * px; ctx.stroke(minor);
      ctx.lineWidth = 3.4 * px; ctx.stroke(major);
      ctx.strokeStyle = 'rgba(10,10,16,0.9)';
      ctx.lineWidth = 1.2 * px; ctx.stroke(minor);
      ctx.lineWidth = 2 * px; ctx.stroke(major);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.day) this.drawCentres();
    if (this.marker) this.drawMarker(...this.marker);
  }

  drawCentres() {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const c of this.centres) {
      const [x, y] = this.toScreen(c.lon, c.lat);
      if (x < -20 || y < -20 || x > this.W + 20 || y > this.H + 20) continue;
      ctx.font = '700 20px ui-sans-serif, system-ui, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeText(c.kind, x, y);
      ctx.fillStyle = c.kind === 'L' ? '#b3122e' : '#123fa8';
      ctx.fillText(c.kind, x, y);
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeText(Math.round(c.value), x, y + 15);
      ctx.fillStyle = '#111';
      ctx.fillText(Math.round(c.value), x, y + 15);
    }
  }

  drawMarker(lon, lat) {
    const [x, y] = this.toScreen(lon, lat);
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, 2 * Math.PI);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#111'; ctx.stroke();
  }

  setMarker(lonlat) {
    this.marker = lonlat;
    this.requestDraw();
  }
}

// ---- helpers -----------------------------------------------------------------

function temperaturePixel(d, o, t) {
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

function veilPixel(d, o, s) {
  const f = Math.min(Math.max((s - VEIL_FROM) / (VEIL_TO - VEIL_FROM), 0), 1);
  d[o] = 24; d[o + 1] = 26; d[o + 2] = 34;
  d[o + 3] = Number.isNaN(s) ? 0 : Math.round(f * VEIL_MAX_ALPHA * 255);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// For each raster column: the two grid columns to blend (wrapping at the date line).
function columnSampler(nx, f, rw) {
  const i0 = new Int32Array(rw), i1 = new Int32Array(rw), fx = new Float32Array(rw);
  for (let p = 0; p < rw; p++) {
    const u = p / f;
    i0[p] = Math.floor(u) % nx;
    i1[p] = (i0[p] + 1) % nx;
    fx[p] = u - Math.floor(u);
  }
  return { i0, i1, fx };
}

// GeoJSON -> Path2D in world coordinates (x = lon, y = -lat), clipped at the date line.
function worldPath(geojson) {
  const projection = d3.geoEquirectangular().scale(180 / Math.PI).translate([0, 0]).precision(0.1);
  const path = new Path2D();
  d3.geoPath(projection, path)(geojson);
  return path;
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
