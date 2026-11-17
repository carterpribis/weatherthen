# Weather Then

Look up the weather for any place on any day from 1836 to today. It has a world weather map for each day and a place report built from weather models and the readings stations took at the time.

## Data pipeline

Source: NOAA-CIRES-DOE 20th Century Reanalysis v3 daily data on a 1° grid (CC BY 4.0).

```bash
python3 -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/fetch.py 1888         # ~525 MB into data/raw/1888 (not committed)
.venv/bin/python pipeline/build_days.py 1888    # site/data/20cr/{days,detail}/1888 + manifest.json, then verifies
.venv/bin/python pipeline/backfill.py 1836 1840 # fetch + build + verify (+ --upload to R2) for many years, resumable
.venv/bin/python pipeline/check_day.py 1888-03-13   # round-trip check + quick-look PNG in data/check/
.venv/bin/python pipeline/validate_station.py 1888 USW00094728 40.779 -73.969   # vs Central Park records
```

Each day produces two gzip files. The format and the manifest (v4: sources, fields and date ranges) are described at the top of `pipeline/build_days.py`. NOAA serves 1806–1980 and 1981–2015 from different folders, and `fetch.py` picks the right one. The full archive plan is in [ARCHIVE_PLAN.md](ARCHIVE_PLAN.md).

- **Map file** (about 130 KB): sea-level pressure, 2 m temperature, and the ensemble spread of each.
- **Detail file** (about 185 KB): daily high and low, total precipitation (8 × the mean 3-hour accumulation), share of the day with snow and with freezing rain, cloud cover, 10 m wind, and snow depth. It feeds the pre-1940 place report and the rain and snow layer.

Validation against New York Central Park's 1888 records (GHCN-Daily USW00094728):

- Daily highs and lows correlate at 0.96 and 0.97, with near-zero bias and a typical error of 2–3 °C.
- The reanalysis catches 95% of the station's wet days but shows rain on more days (173 against 111), so the site needs at least 1 mm before calling a day wet.
- It catches 11 of the 13 snow days.

## Site

Static files in `site/` with no build step: `index.html`, `style.css` and ES modules in `site/js/`. It uses d3 and topojson-client from jsDelivr, plus Natural Earth coastlines from the `world-atlas` package.

- `js/data.js` loads the manifest and decodes day files (gunzip, then unshuffle the bytes).
- `js/map.js` draws on a canvas: the temperature or rain-and-snow raster upsampled 4×, the uncertainty veil, coastlines, isobars every 4 hPa from d3-contour, and H/L centres.
- `js/conditions.js` turns a day of reanalysis detail into words such as "Heavy snow, windy". Its thresholds come from the validation above.
- `js/places.js` handles place search through Open-Meteo's geocoding API (GeoNames). It also accepts typed "lat, lon".
- `js/report.js` builds the place report for any date from 1836 to today:
  - **Open-Meteo:** the ERA5 archive for 1940 to a few days ago, and the forecast API for the last ~90 days (so yesterday works).
  - **NOAA GHCN-Daily:** nearby station records via the NCEI Access Data Service.
  - All of these are keyless and called directly from the browser.
- `js/app.js` handles dates (1836 to today; the slider spans the selected year), playback, search, the report panel, the welcome prompt, units, famous days (`events.json`) and the shareable URL (`?date=&lat=&lon=&place=&cc=`).

Preview locally:

```bash
python3 serve.py
```

`serve.py` serves `site/` with no caching, so code changes show up on reload.

**Data location:** on localhost the site reads data from `site/data/`. Elsewhere it reads from the R2 domain set in `site/js/config.js`. Add `?data=local` or `?data=remote` to override.

Then open http://localhost:8788. Keyboard: ← and → change the day, and space plays or pauses.

## Who wrote what

The pipeline and site code were written by Claude Code (Anthropic) working with Carter Pribis, who directed the project and its design decisions.
