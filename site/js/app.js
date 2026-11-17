import { loadManifest, loadDay, loadDetail, sampleGrid, hasMap, sourceFor, coverageLabel } from './data.js';
import { classifyDay, windFrom } from './conditions.js';
import { datePicker } from './datepicker.js';
import { tempScale, RAIN_STOPS, SNOW_STOPS, FRZ_STOPS, PRECIP_MIN, PRECIP_MAX, PRECIP_TICKS_MM, PRECIP_TICKS_IN } from './colors.js';
import { WeatherMap } from './map.js';
import { searchPlaces, pointPlace } from './places.js';
import { modelDay, stationDay, describeCode, compass, MODEL_FIRST_DATE } from './report.js';
import { FIRST_DATE, today, addDays, daysBetween, clampDate, longDate, shortDate } from './dates.js';

const DEFAULT_DATE = '1888-03-13';
const PLAY_MS = 350;
const PREFETCH = 6;
const REPORT_DELAY = 450; // wait for the date to settle before calling the weather APIs
const PLACE_ZOOM = 6.3;     // MapLibre zoom: about a state's width

const $ = (id) => document.getElementById(id);
const els = {
  canvas: $('map'), dateLong: $('date-long'), datePickerEl: $('date-picker'), slider: $('slider'),
  prev: $('prev'), next: $('next'), play: $('play'), uncertainty: $('uncertainty'),
  legendBar: $('legend-bar'), legendTicks: $('legend-ticks'),
  tip: $('tip'), status: $('status'), about: $('about'),
  aboutOpen: $('about-open'), aboutClose: $('about-close'), reset: $('reset'), legend: $('legend'),
  search: $('place-search'), results: $('place-results'), report: $('report'),
  reportBody: $('report-body'), reportClose: $('report-close'), notice: $('notice'),
  welcome: $('welcome'),
};

const state = {
  date: DEFAULT_DATE, place: null, playing: false, fahrenheit: true, pointer: null, layer: 'temp',
  dayLoaded: null, reportTimer: 0, reportToken: 0,
};
let manifest, map, picker;

function markUnits() {
  document.querySelectorAll('.unit-toggle button').forEach((b) =>
    b.setAttribute('aria-pressed', String((b.dataset.units === 'F') === state.fahrenheit)));
}

main().catch((err) => {
  console.error(err);
  setStatus(`Couldn't load the map: ${err.message}`, true);
});

async function main() {
  setStatus('Loading…');
  const m = await loadManifest();
  manifest = m;
  map = new WeatherMap(els.canvas, m);
  map.onChange = () => updateTip();
  await map.ready;

  try { state.fahrenheit = (localStorage.getItem('units') || 'F') === 'F'; } catch {}  // °F unless chosen
  markUnits();
  if (matchMedia('(max-width: 700px)').matches) els.legend.open = false;

  setupDateControls();
  setupSearch();
  setupMisc();
  drawLegend();

  const q = new URLSearchParams(location.search);
  if (q.get('layer') === 'precip') setLayer('precip');
  const lat = parseFloat(q.get('lat')), lon = parseFloat(q.get('lon'));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const p = pointPlace(lat, lon);
    setPlace({ ...p, label: q.get('place') || p.label, countryCode: q.get('cc') || null }, { fly: true, instant: true });
  }
  if (!state.place) els.welcome.hidden = false;   // first step, until a place is picked
  await show(clampDate(q.get('date')) || DEFAULT_DATE);
  setStatus('');
}

// ---- dates -------------------------------------------------------------------------

async function show(date) {
  date = clampDate(date);
  if (!date) return;
  state.date = date;
  const year = date.slice(0, 4);
  const lastOfYear = year === today().slice(0, 4) ? today() : `${year}-12-31`;
  els.slider.max = daysBetween(`${year}-01-01`, lastOfYear);
  els.slider.value = daysBetween(`${year}-01-01`, date);
  els.slider.setAttribute('aria-valuetext', longDate(date));
  picker.set(date);
  els.dateLong.textContent = longDate(date);
  els.prev.disabled = date <= FIRST_DATE;
  els.next.disabled = date >= today();
  updateUrl();
  scheduleReport();

  updateNotice();
  updateSource(sourceFor(manifest, date));
  if (!hasMap(manifest, date)) {
    state.dayLoaded = null;
    map.clearDay();
    updateTip();
    return;
  }

  const slow = setTimeout(() => setStatus('Loading…'), 250);
  try {
    const [day, detail] = await Promise.all([
      loadDay(manifest, date),
      state.layer === 'precip' ? loadDetail(manifest, date).catch(() => null) : null,
    ]);
    if (state.date !== date) return; // moved on
    map.setDay(day, detail);
    state.dayLoaded = date;
    setStatus('');
    updateTip();
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't load the map for ${date}`, true);
  } finally {
    clearTimeout(slow);
  }
  for (let k = 1; k <= PREFETCH; k++) {
    const d = addDays(date, k);
    if (!hasMap(manifest, d)) continue;
    loadDay(manifest, d).catch(() => {});
    if (state.layer === 'precip') loadDetail(manifest, d).catch(() => {});
  }
}

/** Credit line, uncertainty toggle and labels follow the source of the shown map. */
function updateSource(src) {
  const credit = $('map-credit');
  if (src) {
    credit.textContent = src.short + (src.preliminary ? ' (preliminary)' : '');
    credit.href = src.url;
  }
  const canVeil = !src || src.spread;
  els.uncertainty.disabled = !canVeil;
  els.uncertainty.closest('label').title = canVeil ? '' : 'Uncertainty is only available for 20CRv3 maps (to 2015)';
  map.setUncertainty(canVeil && els.uncertainty.checked);
}

function updateNotice() {
  if (hasMap(manifest, state.date)) { els.notice.hidden = true; return; }
  els.notice.textContent = `No map for this date yet (maps so far: ${coverageLabel(manifest)}).`;
  els.notice.hidden = false;
}

function setupDateControls() {
  picker = datePicker(els.datePickerEl, { label: 'Date', onChange: (d) => { stop(); show(d); } });
  els.slider.addEventListener('input', () => {
    stop();
    show(addDays(`${state.date.slice(0, 4)}-01-01`, +els.slider.value));
  });
  els.prev.addEventListener('click', () => { stop(); show(addDays(state.date, -1)); });
  els.next.addEventListener('click', () => { stop(); show(addDays(state.date, 1)); });
  els.play.addEventListener('click', () => (state.playing ? stop() : play()));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, button, dialog[open], [role="listbox"]')) return;
    if (e.key === 'ArrowLeft') { stop(); show(addDays(state.date, -1)); }
    else if (e.key === 'ArrowRight') { stop(); show(addDays(state.date, 1)); }
    else if (e.key === ' ') { e.preventDefault(); state.playing ? stop() : play(); }
  });
}

async function play() {
  state.playing = true;
  els.play.setAttribute('aria-pressed', 'true');
  els.play.textContent = '❚❚';
  els.play.title = 'Pause (space)';
  while (state.playing && state.date < today()) {
    const started = performance.now();
    await show(addDays(state.date, 1));
    const wait = PLAY_MS - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  stop();
}

function stop() {
  if (!state.playing) return;
  state.playing = false;
  els.play.setAttribute('aria-pressed', 'false');
  els.play.textContent = '▶';
  els.play.title = 'Play (space)';
  scheduleReport();
}

// ---- place search ------------------------------------------------------------------------

function setupSearch() {
  let timer = 0, controller = null, items = [], active = -1;

  const close = () => {
    els.results.hidden = true;
    els.search.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const highlight = (i) => {
    active = i;
    [...els.results.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    els.search.setAttribute('aria-activedescendant', i >= 0 ? `place-opt-${i}` : '');
  };
  const choose = (place) => {
    close();
    setPlace(place, { fly: true });
    els.search.blur();
  };
  const render = (list, message) => {
    items = list;
    els.results.innerHTML = '';
    if (message) {
      els.results.innerHTML = `<li class="empty" role="presentation">${message}</li>`;
    }
    list.forEach((p, i) => {
      const li = document.createElement('li');
      li.id = `place-opt-${i}`;
      li.setAttribute('role', 'option');
      li.textContent = p.label;
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); choose(p); });
      els.results.append(li);
    });
    els.results.hidden = false;
    els.search.setAttribute('aria-expanded', 'true');
    highlight(list.length ? 0 : -1);
  };

  els.search.addEventListener('input', () => {
    clearTimeout(timer);
    const q = els.search.value;
    if (q.trim().length < 2) { close(); return; }
    timer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const list = await searchPlaces(q, controller.signal);
        if (els.search.value !== q) return;
        render(list, list.length ? '' : 'No places found');
      } catch (err) {
        if (err.name !== 'AbortError') render([], 'Place search is unavailable right now');
      }
    }, 250);
  });
  els.search.addEventListener('keydown', (e) => {
    if (els.results.hidden && e.key !== 'Enter') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(active + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) choose(items[active]); }
    else if (e.key === 'Escape') { close(); }
  });
  els.search.addEventListener('blur', () => setTimeout(close, 100));
  els.search.addEventListener('focus', () => { if (state.place) els.search.select(); });
}

function setPlace(place, { fly = false, instant = false } = {}) {
  state.place = place;
  els.search.value = place ? place.label : '';
  map.setMarker(place ? [place.lon, place.lat] : null);
  els.report.hidden = !place;
  document.body.classList.toggle('has-report', !!place);
  if (place && fly) {
    const pad = visiblePadding();
    if (instant) map.jumpTo(place.lon, place.lat, PLACE_ZOOM, pad);
    else map.flyTo(place.lon, place.lat, PLACE_ZOOM, pad);
  }
  updateNotice();
  updateUrl();
  scheduleReport(0);
  if (place) hideWelcome();
}

/** Map padding that keeps a place clear of the report (side panel on desktop, sheet on phones). */
function visiblePadding() {
  if (matchMedia('(max-width: 700px)').matches) {
    const top = document.querySelector('.title-card').getBoundingClientRect().bottom;
    return { top, bottom: Math.round(innerHeight * 0.55), left: 0, right: 0 };
  }
  const right = document.querySelector('.left-col').getBoundingClientRect().right;
  return { left: Math.round(right), top: 0, right: 0, bottom: 0 };
}

// ---- place report --------------------------------------------------------------------------

function scheduleReport(delay = REPORT_DELAY) {
  clearTimeout(state.reportTimer);
  if (!state.place) return;
  renderReportShell();
  if (state.playing) return;
  state.reportTimer = setTimeout(loadReport, delay);
}

function renderReportShell() {
  const { place, date } = state;
  els.reportBody.innerHTML = `
    <div class="r-head">
      <div class="r-place">${esc(place.label)}</div>
      <div class="r-date">${longDate(date)}</div>
    </div>
    <section id="r-model" class="r-section"><p class="r-loading">${state.playing ? 'Pause to load this day’s weather.' : 'Loading the weather…'}</p></section>
    <section id="r-stations" class="r-section"></section>
    <section id="r-archives" class="r-section"></section>`;
}

async function loadReport() {
  const token = ++state.reportToken;
  const { place, date } = state;
  const stale = () => token !== state.reportToken;

  // 1. Model summary
  const modelEl = $('r-model');
  if (date >= MODEL_FIRST_DATE) {
    modelDay(place, date)
      .then((m) => { if (!stale()) modelEl.innerHTML = m ? modelHtml(m) : ''; if (!stale() && m) drawHourly(m); })
      .catch((err) => { if (!stale()) modelEl.innerHTML = `<p class="r-note">Couldn’t load model weather: ${esc(err.message)}</p>`; });
  } else if (hasMap(manifest, date)) {
    const [day, detail] = await Promise.all([
      loadDay(manifest, date).catch(() => null),
      loadDetail(manifest, date).catch(() => null),
    ]);
    if (stale()) return;
    modelEl.innerHTML = reanalysisHtml(place, day, detail);
  } else {
    modelEl.innerHTML = '<p class="r-note">No model data for this date yet.</p>';
  }

  // 2. Station records
  const stEl = $('r-stations');
  stEl.innerHTML = '<h3>Recorded at nearby stations</h3><p class="r-loading">Searching NOAA station records…</p>';
  stationDay(place, date)
    .then((list) => { if (!stale()) stEl.innerHTML = stationsHtml(list, date); })
    .catch(() => { if (!stale()) stEl.innerHTML = '<h3>Recorded at nearby stations</h3><p class="r-note">NOAA’s station records are unavailable right now.</p>'; });

  // 3. Archive links
  $('r-archives').innerHTML = archivesHtml(place, date);
}

function modelHtml(m) {
  const { text, icon } = describeCode(m.code);
  const facts = [];
  facts.push(['Precipitation', fmtMm(m.precip)]);
  if (m.snow > 0) facts.push(['Snowfall', fmtCm(m.snow)]);
  if (m.sunshineHours != null) facts.push(['Sunshine', `${m.sunshineHours.toFixed(1)} h`]);
  if (m.windMax != null) {
    facts.push(['Wind', `${fmtSpeed(m.windMax)} ${compass(m.windDir)}` + (m.gustMax ? `, gusts ${fmtSpeed(m.gustMax)}` : '')]);
  }
  const source = m.source === 'era5'
    ? sourceLine('ERA5 reanalysis by ECMWF / Copernicus, via Open-Meteo', 'https://open-meteo.com/en/docs/historical-weather-api',
      'Model reconstruction, ~25 km grid.')
    : sourceLine('Recent weather-model data, via Open-Meteo', 'https://open-meteo.com/en/docs',
      'Recent model data; may still be revised.');
  const partial = state.date === today() ? '<p class="r-note">Today includes forecast hours.</p>' : '';
  return `
    <div class="r-summary">
      <span class="r-icon" aria-hidden="true">${icon}</span>
      <div>
        <div class="r-cond">${text}</div>
        <div class="r-temps">High <b>${fmtTemp(m.tmax)}</b> · Low <b>${fmtTemp(m.tmin)}</b></div>
      </div>
    </div>
    <dl class="r-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <figure class="r-chart"><svg id="r-hourly" role="img" aria-label="Hourly temperature and precipitation"></svg>
</figure>
    ${partial}${source}`;
}

function reanalysisHtml(place, day, detail) {
  if (!day) return '<p class="r-note">Couldn’t load the reconstruction for this day.</p>';
  const s = sampleGrid(manifest.grid, day.fields, place.lon, place.lat);
  const d = detail && sampleGrid(manifest.grid, detail.fields, place.lon, place.lat);
  const facts = [];
  let head;
  if (d) {
    const { text, icon } = classifyDay(d);
    head = `<span class="r-icon" aria-hidden="true">${icon}</span>
      <div>
        <div class="r-cond">${text}</div>
        <div class="r-temps">High <b>${fmtTemp(d.tmax)}</b> · Low <b>${fmtTemp(d.tmin)}</b></div>
      </div>`;
    // Precipitation is the depth of water (snow melted). When it snowed, also give a rough
    // snow depth: fresh snow is about 10x its melted water (5x wet, 20x powder).
    const snowy = d.precip >= 1 && d.snow_frac >= 0.15;
    const how = !snowy ? '' : d.snow_frac >= 0.8 ? 'as snow' : `snow ${Math.round(d.snow_frac * 100)}% of the day`;
    facts.push(['Precipitation', `${fmtMm(d.precip)}${how ? ` <small>${how}</small>` : ''}`]);
    if (snowy) {
      const snowCm = d.precip * Math.min(1, d.snow_frac / 0.8);   // mm of water x 10 = mm of snow = this many cm
      facts.push(['Snowfall (est.)', `about ${fmtSnowEstimate(snowCm)}`]);
    }
    facts.push(['Cloud cover', `${Math.round(d.cloud)}%`]);
    facts.push(['Average wind', `${fmtSpeed(Math.hypot(d.u10, d.v10) * 3.6)} ${compass(windFrom(d.u10, d.v10))}`]);
    if (d.snow_depth >= 0.5) facts.push(['Snow on ground', fmtCm(d.snow_depth)]);
  } else {
    head = `<span class="r-icon" aria-hidden="true">🌡️</span>
      <div><div class="r-cond">Average ${fmtTemp(s.t2m)}</div></div>`;
  }
  facts.push(['Average temp.', `${fmtTemp(s.t2m)}${pm(s.t2m_spread, fmtDelta)}`]);
  facts.push(['Pressure', `${s.prmsl.toFixed(0)} hPa${pm(s.prmsl_spread, (v) => v.toFixed(1))}`]);
  return `
    <div class="r-summary">${head}</div>
    <dl class="r-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    ${sourceLine('NOAA-CIRES-DOE 20th Century Reanalysis v3', 'https://psl.noaa.gov/data/gridded/data.20thC_ReanV3.html',
      'Model reconstruction from historical pressure readings, ~110 km grid. ± is the spread of its 80 runs.')}`;
}

function stationsHtml(list, date) {
  const head = '<h3>Recorded at nearby stations</h3>';
  if (!list.length) {
    const recent = daysBetween(date, today()) < 30;
    return head + `<p class="r-note">${recent
      ? 'No station records yet; NOAA adds them after a few days.'
      : 'No station records within about 150 km.'}</p>`;
  }
  const rows = list.map((s) => {
    const bits = [];
    if (s.tmax != null || s.tmin != null) bits.push(`High ${fmtTemp(s.tmax)} · Low ${fmtTemp(s.tmin)}`);
    if (s.precip != null) bits.push(`Precip ${fmtMm(s.precip)}`);
    if (s.snow) bits.push(`Snow ${fmtCm(s.snow)}`);
    if (s.snowDepth) bits.push(`Snow on ground ${fmtCm(s.snowDepth)}`);
    const types = s.types.length ? `<div class="st-types">Observed: ${s.types.join(', ')}</div>` : '';
    const page = `https://www.ncei.noaa.gov/cdo-web/datasets/GHCND/stations/GHCND:${encodeURIComponent(s.id)}/detail`;
    return `<li><div class="st-name"><a href="${page}" target="_blank" rel="noopener">${esc(s.name)}</a> <span>${fmtKm(s.km)}</span></div>
      <div class="st-vals">${bits.join(' · ') || 'No temperature or precipitation recorded'}</div>${types}</li>`;
  }).join('');
  return head + `<ul class="stations">${rows}</ul>` + sourceLine('NOAA NCEI, Global Historical Climatology Network – Daily (GHCN-Daily)',
    'https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily',
    '');
}

function archivesHtml(place, date) {
  const inUS = place.countryCode ? place.countryCode === 'US'
    : place.lat > 18 && place.lat < 72 && place.lon > -170 && place.lon < -60;
  if (!inUS) return '';
  const links = [];
  const next = addDays(date, 1);
  if (next >= '1770-01-01' && next <= '1963-12-31') {
    const url = `https://www.loc.gov/collections/chronicling-america/?dl=page&end_date=${next}&ops=AND&qs=weather&searchType=advanced&start_date=${next}`;
    links.push(`<li><a href="${url}" target="_blank" rel="noopener">Next day’s newspapers</a> <span class="src">(Library of Congress)</span></li>`);
  }
  if (date >= '1871-01-01' && date <= '2002-12-31') {
    links.push(`<li><a href="https://library.noaa.gov/weather-climate/daily-weather-maps" target="_blank" rel="noopener">US Weather Bureau daily maps</a> <span class="src">(NOAA Central Library)</span></li>`);
  }
  return links.length ? `<h3>From the archives</h3><ul class="links">${links.join('')}</ul>` : '';
}

function drawHourly(m) {
  const svg = d3.select('#r-hourly');
  if (svg.empty() || !m.hours.length) return;
  const W = 300, H = 96, pad = { l: 30, r: 26, t: 8, b: 18 };
  svg.attr('viewBox', `0 0 ${W} ${H}`);
  const hours = m.hours;
  const temps = hours.map((h) => toTemp(h.temp));
  const x = d3.scaleLinear().domain([0, 23]).range([pad.l, W - pad.r]);
  const [t0, t1] = d3.extent(temps);
  const y = d3.scaleLinear().domain([Math.floor(t0) - 1, Math.ceil(t1) + 1]).nice(4).range([H - pad.b, pad.t]);
  const pmax = Math.max(state.fahrenheit ? 0.1 : 2, d3.max(hours, (h) => toMm(h.precip)) || 0);
  const yp = d3.scaleLinear().domain([0, pmax]).range([H - pad.b, pad.t + 20]);
  const bw = (W - pad.l - pad.r) / 24 - 1.5;

  svg.selectAll('*').remove();
  svg.append('g').attr('class', 'grid').selectAll('line').data(y.ticks(4)).join('line')
    .attr('x1', pad.l).attr('x2', W - pad.r).attr('y1', y).attr('y2', y);
  svg.append('g').attr('class', 'bars').selectAll('rect').data(hours.filter((h) => h.precip > 0)).join('rect')
    .attr('x', (h) => x(h.hour) - bw / 2).attr('width', bw)
    .attr('y', (h) => yp(toMm(h.precip))).attr('height', (h) => yp(0) - yp(toMm(h.precip)))
    .attr('class', (h) => (h.snow > 0 ? 'snow' : 'rain'));
  svg.append('path').attr('class', 'temp-line')
    .attr('d', d3.line().x((h) => x(h.hour)).y((h, i) => y(temps[i])).curve(d3.curveMonotoneX)(hours));
  svg.append('g').attr('class', 'axis').selectAll('text').data(y.ticks(4)).join('text')
    .attr('x', pad.l - 4).attr('y', y).attr('dy', '0.32em').attr('text-anchor', 'end').text((t) => `${t}°`);
  svg.append('g').attr('class', 'axis').selectAll('text').data([0, 6, 12, 18]).join('text')
    .attr('x', x).attr('y', H - 4).attr('text-anchor', 'middle')
    .text((h) => (h === 0 ? 'midnight' : h === 12 ? 'noon' : `${h % 12}${h < 12 ? 'am' : 'pm'}`));
  svg.append('text').attr('class', 'axis').attr('x', W).attr('y', yp(pmax)).attr('dy', '0.32em')
    .attr('text-anchor', 'end')
    .text(state.fahrenheit ? `${pmax.toFixed(2)}″` : `${pmax.toFixed(1)} mm`);
}

// ---- map layer -------------------------------------------------------------------------------

function setLayer(layer) {
  state.layer = layer;
  document.querySelectorAll('input[name="layer"]').forEach((r) => { r.checked = r.value === layer; });
  const precip = layer === 'precip';
  $('legend-temp').hidden = precip;
  $('legend-precip').hidden = !precip;
  $('legend-title').textContent = precip
    ? 'Rain and snow'
    : 'Daily average temperature';
  map.setLayer(layer);
  if (precip && state.dayLoaded && !map.detail) {
    const date = state.dayLoaded;
    loadDetail(manifest, date).then((d) => map.setDetail(d)).catch(() => setStatus('Couldn’t load rain and snow for this day', true));
  }
  if (manifest) updateUrl();
}

function precipKind(s) {
  if (!(s.precip >= 1)) return 'dry';
  if (s.frz_frac >= 0.25) return 'freezing rain';
  if (s.snow_frac >= 0.5) return 'snow';
  return s.snow_frac >= 0.15 ? 'rain & snow' : 'rain';
}

function hideWelcome() {
  els.welcome.hidden = true;
}

// ---- misc controls, readout, legend ----------------------------------------------------------------

function setupMisc() {
  els.reset.addEventListener('click', () => map.resetView());
  document.querySelectorAll('input[name="layer"]').forEach((r) =>
    r.addEventListener('change', () => { if (r.checked) setLayer(r.value); }));
  els.uncertainty.addEventListener('change', () => {
    map.setUncertainty(els.uncertainty.checked);
    $('veil-key').hidden = !els.uncertainty.checked;
  });
  document.querySelectorAll('.unit-toggle button').forEach((b) => b.addEventListener('click', () => {
    state.fahrenheit = b.dataset.units === 'F';
    try { localStorage.setItem('units', b.dataset.units); } catch {}
    markUnits();
    drawLegend();
    updateTip();
    if (state.place) scheduleReport(0);
  }));
  els.reportClose.addEventListener('click', () => setPlace(null));
  els.aboutOpen.addEventListener('click', () => els.about.showModal());
  els.aboutClose.addEventListener('click', () => els.about.close());
  els.about.addEventListener('click', (e) => { if (e.target === els.about) els.about.close(); });


  // Mouse hover shows a readout; a click or tap (not a drag) picks that spot as the place.
  map.onHover((lonlat, point) => {
    state.pointer = point ? [point.x, point.y] : null;
    updateTip();
  });
  map.onPick((lon, lat) => setPlace(pointPlace(lat, lon)));
}

function updateTip() {
  const { tip } = els;
  const at = state.pointer;
  const lonlat = at && map.toLonLat(...at);
  const s = lonlat && state.dayLoaded && map.sample(...lonlat);
  if (!s) { tip.hidden = true; return; }
  const [lon, lat] = lonlat;
  tip.innerHTML = `
    <div class="tip-place">${fmtLat(lat)}, ${fmtLon(lon)}</div>
    <div class="tip-row"><span>Temperature</span><b>${fmtTemp(s.t2m)}</b>${pm(s.t2m_spread, fmtDelta) || '<small></small>'}</div>
    <div class="tip-row"><span>Pressure</span><b>${s.prmsl.toFixed(0)} hPa</b>${pm(s.prmsl_spread, (v) => v.toFixed(1)) || '<small></small>'}</div>` +
    (s.precip != null ? `<div class="tip-row"><span>Precip.</span><b>${fmtMm(s.precip)}</b><small>${precipKind(s)}</small></div>` : '');
  tip.hidden = false;
  const pad = 14, r = tip.getBoundingClientRect();
  let x = at[0] + pad, y = at[1] + pad;
  if (x + r.width > innerWidth - 8) x = at[0] - pad - r.width;
  if (y + r.height > innerHeight - 8) y = at[1] - pad - r.height;
  tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}

function drawLegend() {
  const c = els.legendBar, ctx = c.getContext('2d');
  const lo = -40, hi = 40;
  for (let x = 0; x < c.width; x++) {
    ctx.fillStyle = tempScale(lo + (hi - lo) * (x / (c.width - 1)));
    ctx.fillRect(x, 0, 1, c.height);
  }
  const ticks = state.fahrenheit ? [-40, -4, 32, 68, 104] : [-40, -20, 0, 20, 40];
  els.legendTicks.innerHTML = ticks.map((t) => `<span>${t}°</span>`).join('');

  for (const [id, stops] of [['legend-rain', RAIN_STOPS], ['legend-snow', SNOW_STOPS], ['legend-frz', FRZ_STOPS]]) {
    const cv = $(id), cx = cv.getContext('2d'), f = d3.interpolateRgbBasis(stops);
    for (let x = 0; x < cv.width; x++) { cx.fillStyle = f(x / (cv.width - 1)); cx.fillRect(x, 0, 1, cv.height); }
  }
  // Ticks sit at their log-scale positions along the ramp.
  const span = Math.log(PRECIP_MAX / PRECIP_MIN);
  const pTicks = state.fahrenheit ? PRECIP_TICKS_IN : PRECIP_TICKS_MM;
  $('legend-precip-ticks').innerHTML = pTicks.map((v, i) => {
    const mm = state.fahrenheit ? v * 25.4 : v;
    const pct = Math.min(100, Math.max(0, (Math.log(mm / PRECIP_MIN) / span) * 100));
    const last = i === pTicks.length - 1;
    const label = `${v}${last ? (state.fahrenheit ? ' in' : ' mm') : ''}`;
    return `<span style="left:${pct}%"${last ? ' class="last"' : ''}>${label}</span>`;
  }).join('');
}

function updateUrl() {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('date', state.date);
  if (state.layer !== 'temp') url.searchParams.set('layer', state.layer);
  if (state.place) {
    url.searchParams.set('lat', state.place.lat);
    url.searchParams.set('lon', state.place.lon);
    url.searchParams.set('place', state.place.label);
    if (state.place.countryCode) url.searchParams.set('cc', state.place.countryCode);
  }
  history.replaceState(null, '', url);
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.hidden = !text;
  els.status.classList.toggle('error', isError);
}

// ---- formatting (°C/mm/km/h, or °F/in/mph) -----------------------------------------------------------

const toTemp = (c) => (state.fahrenheit ? c * 9 / 5 + 32 : c);
const toMm = (mm) => (state.fahrenheit ? mm / 25.4 : mm);
const fmtTemp = (c) => (c == null ? '–' : state.fahrenheit ? `${toTemp(c).toFixed(0)} °F` : `${c.toFixed(1)} °C`);
const fmtDelta = (c) => (state.fahrenheit ? `${(c * 9 / 5).toFixed(1)}°` : `${c.toFixed(1)}°`);
const fmtMm = (mm) => (mm == null ? '–' : state.fahrenheit ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`);
/** A rough snow depth: whole numbers above 2, one decimal below. */
const fmtSnowEstimate = (cm) => {
  const v = state.fahrenheit ? cm / 2.54 : cm;
  return `${v >= 2 ? Math.round(v) : v.toFixed(1)} ${state.fahrenheit ? 'in' : 'cm'}`;
};
const fmtCm = (cm) => (cm == null ? '–' : state.fahrenheit ? `${(cm / 2.54).toFixed(1)} in` : `${cm.toFixed(1)} cm`);
const fmtSpeed = (kmh) => (state.fahrenheit ? `${(kmh / 1.609).toFixed(0)} mph` : `${kmh.toFixed(0)} km/h`);
const fmtKm = (km) => (state.fahrenheit ? `${(km / 1.609).toFixed(0)} mi away` : `${km.toFixed(0)} km away`);
const fmtLat = (v) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`;
/** "Source: <name>" with a link and a one-line note on what kind of data it is. */
function sourceLine(name, url, note) {
  return `<p class="r-source"><b>Source:</b> <a href="${url}" target="_blank" rel="noopener">${name}</a>${note ? `. ${note}` : ''}</p>`;
}

/** ' ± x' as a <small>, or '' when the source has no ensemble spread. */
const pm = (v, fmt) => (Number.isFinite(v) ? ` <small>± ${fmt(v)}</small>` : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
