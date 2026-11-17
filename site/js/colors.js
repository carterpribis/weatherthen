// Temperature colour scale (°C). A light band around 0 °C marks the freezing line.

export const T_MIN = -50;
export const T_MAX = 50;
const STEP = 0.1;

const STOPS = [
  // The cold end stays mid-toned (not near-black) so dark isobars remain readable.
  [-50, '#6b3f9e'], [-40, '#7552b8'], [-30, '#5f6fd0'], [-20, '#4b8fd6'],
  [-10, '#6fbbe6'], [-3, '#b6e0f0'], [0, '#eef6f4'], [3, '#f4ecb0'],
  [10, '#f7cf6a'], [20, '#f19440'], [30, '#de5530'], [40, '#b0243a'], [50, '#82143a'],
];

export const tempScale = d3.scaleLinear()
  .domain(STOPS.map((s) => s[0]))
  .range(STOPS.map((s) => s[1]))
  .interpolate(d3.interpolateLab)
  .clamp(true);

/** Flat RGB lookup table: index = round((t - T_MIN) / 0.1). */
export const tempLut = (() => {
  const n = Math.round((T_MAX - T_MIN) / STEP) + 1;
  const lut = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const c = d3.rgb(tempScale(T_MIN + i * STEP));
    lut[i * 3] = c.r; lut[i * 3 + 1] = c.g; lut[i * 3 + 2] = c.b;
  }
  return lut;
})();

export function tempIndex(t) {
  const k = Math.round((t - T_MIN) / STEP);
  return k < 0 ? 0 : k > tempLut.length / 3 - 1 ? tempLut.length / 3 - 1 : k;
}

// Rain and snow layer: daily total (mm, water equivalent) on a log scale from
// PRECIP_MIN to PRECIP_MAX, coloured by type. Snow share blends rain -> snow.
export const PRECIP_MIN = 1;
export const PRECIP_MAX = 50;
export const PRECIP_TICKS_MM = [1, 10, 50];        // key labels in mm (°C)
export const PRECIP_TICKS_IN = [0.05, 0.5, 2];     // key labels in inches (°F)
const RAMP_STEPS = 64;
const ramp = (stops) => {
  const f = d3.interpolateRgbBasis(stops);
  const out = new Uint8ClampedArray(RAMP_STEPS * 3);
  for (let i = 0; i < RAMP_STEPS; i++) {
    const c = d3.rgb(f(i / (RAMP_STEPS - 1)));
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  }
  return out;
};
export const RAIN_STOPS = ['#cfe4f6', '#9cc7ec', '#5a9ed8', '#2a6cb8', '#103d84'];
export const SNOW_STOPS = ['#eadcf5', '#cfaeea', '#a675d2', '#7a46b0', '#4f2082'];
export const FRZ_STOPS = ['#f6c1ca', '#ee8ea0', '#dc5a78', '#b23558', '#7d1c3c'];
export const rainRamp = ramp(RAIN_STOPS);
export const snowRamp = ramp(SNOW_STOPS);
export const frzRamp = ramp(FRZ_STOPS);

/** Ramp index (0..63) for a precipitation amount; -1 when below the minimum. */
export function precipIndex(mm) {
  if (!(mm >= PRECIP_MIN * 0.5)) return -1;
  const t = Math.log(Math.max(mm, PRECIP_MIN) / PRECIP_MIN) / Math.log(PRECIP_MAX / PRECIP_MIN);
  return Math.min(RAMP_STEPS - 1, Math.round(t * (RAMP_STEPS - 1)));
}

// Uncertainty veil: sea-level pressure ensemble spread (hPa) -> opacity.
export const VEIL_FROM = 2;   // hPa: fully clear at or below
export const VEIL_TO = 10;    // hPa: fully veiled at or above
export const VEIL_MAX_ALPHA = 0.78;
