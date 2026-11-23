# Map archive plan: every day from 1836 to yesterday

Status (22 Nov 2026): **2016 onward now comes from NOAA, not Copernicus.** The ERA5 download stopped on 17 Nov when Copernicus rejected year-sized requests as too large, after months of queueing for two months of data. `pipeline/ncep.py` (NCEP/NCAR Reanalysis 1, 2016 to 17 Mar 2026) and `pipeline/gfs.py` (GFS, 18 Mar 2026 on) replace it; neither needs an account or a queue. The ERA5 sections below are kept as a record. `gfs.py --recent N --upload` is the piece a daily job would run.

## Goal

A map (temperature, pressure, rain and snow) for every day from 1 January 1836 to the most recent day available. It updates itself daily, with no laptop needed, in the day-file format the site already reads.

## Where each day's map comes from

| Dates | Source | Why | Arrives |
|---|---|---|---|
| 1836–2015 | **NOAA 20CRv3** (what 1888 uses now) | Same pipeline, same fields, includes the uncertainty spread | One-time backfill |
| 2016 → 17 Mar 2026 | **NOAA NCEP/NCAR Reanalysis 1** (PSL, same server as 20CR) | Small yearly files, no queue. Coarser (about 1.9°), interpolated to 1°. PSL stopped updating its copy in March 2026 | One-time backfill, about a minute a year |
| 18 Mar 2026 → yesterday | **NOAA GFS** analyses and short forecasts (public AWS bucket, 1° files, only the needed fields fetched) | Already on the site's grid; published within hours | Backfill at about 2 s a day, then daily |
| ~~2016 → 5 days ago~~ | ~~ERA5 / ERA5T (Copernicus)~~ | Dropped: the request queue made it impractical. January and February 2016 were built and remain in the bucket, unused | |

All three are converted to the same 1° grid and the same field ids (`prmsl`, `t2m`, `tmax`, `precip`, `snow_frac`…). The front end decodes them the same way.

Notes on fields:
- **Uncertainty:** ERA5 and GFS have no 80-member spread, so the "Show uncertainty" toggle and the ± values only appear for 20CR dates.
- **Snow share:** ERA5 gives snowfall and total precipitation, so snow share = snowfall ÷ precipitation.
- **Freezing rain:** ERA5's precipitation type is instantaneous, so freezing rain starts as 0 for ERA5 days. That's acceptable for v1.
- **GFS:** it has the same categorical snow and freezing-rain fields as 20CR, since both are NCEP models.

20CR's files are split across two folders:

| Years | Folder pattern |
|---|---|
| 1806–1980 | `…/Dailies/<group>SI/` |
| 1981–2015 | `…/Dailies/<group>MO/` (the same files under a different folder name) |

All 13 fields were confirmed present in both. The 1806–1835 years are an experimental extension beyond the official 1836 start (see decision A below).

## Storage and serving

- **Bucket:** a Cloudflare R2 bucket, `weatherthen-data`, served on a custom domain such as `data.weather.prib.is`. That needs prib.is to be a zone in the same Cloudflare account.
- **CORS:** allow GET from `weather.prib.is`, `weatherthen.com` and `localhost`.
- **Layout:** `{source}/{kind}/{year}/{date}.bin.gz`, e.g. `20cr/days/1888/1888-03-13.bin.gz` or `era5/detail/2024/2024-07-04.bin.gz`. When GFS is replaced by ERA5, the URL changes. So every day file is safe to cache forever (`Cache-Control: public, max-age=31536000, immutable`).
- **Manifest:** `manifest.json` (cached 5 minutes) lists the grid, each source's fields, and date ranges such as `{source: "era5", start: "2016-01-01", end: "2026-11-11"}`.

Size and cost:

| | Days | Objects (map + detail) | Size |
|---|---|---|---|
| 20CR 1836–2015 | 65,744 | 131,488 | ~20.7 GB (315 KB/day measured on 1888) |
| ERA5 2016–now | ~3,970 | ~7,940 | ~1.3 GB (January 2016 measured 10.6 MB, so about 1.4 GB) |
| **Total** | | **~140,000** | **~22 GB** |

- **Storage:** R2 includes 10 GB a month free, then $0.015 per GB-month. 22 GB comes to about **$0.18 a month**.
- **Uploads:** about 140k writes, well inside the 1M Class A operations free each month.
- **Reads:** 10M a month are free, and egress is free.
- **Setup:** enabling R2 needs a payment method on the Cloudflare account even when usage stays free (check this when setting up).

## Backfill (one time, on the Mac)

1. **Make `fetch.sh` year-aware:** use `SI` folders up to 1980 and `MO` from 1981.
2. **New script, `pipeline/backfill.py`:** for each year, fetch, build, check, upload, then delete the raw and built files.
   - **Resumable:** a `data/backfill-state.json` file records finished years.
   - **Parallel:** downloads 4 files at a time. Measured: each connection is capped at about 0.8 MB/s, and 4 together gave about 3.2 MB/s.
   - **Polite:** no more than 4–6 connections to NOAA's server.
   - **Disk:** at most about 1 GB in use at once. The Mac has 39 GB free, so the 21 GB output is not kept locally.
   - **Upload:** `rclone` to R2's S3-compatible API. Its key stays in `~/.config/rclone` and is never in the repo.
3. **Time:** 20CR is 180 years × ~525 MB ≈ **94 GB** to download.
   - At ~3.2 MB/s that's about **8–9 hours**, best run overnight.
   - Building takes about 30 s a year, or 1.5 hours in all.
   - If it runs inside a Claude Code session, keep the Mac awake.
4. **ERA5 2016 onwards:** a CDS API script, two requests per year (hourly temperature and precipitation; 3-hourly pressure, cloud, wind and snow). Each request waits about 2–3 hours in the Copernicus queue whatever its size, so monthly requests (about 5.5 hours a month, about 30 days in all) were switched to yearly ones (about 22 requests).
   - **Download size:** to measure with one test month before committing.
   - **Speed:** CDS queues requests, so expect hours to a day.
   - **Grid:** tested on 16 Nov 2026: the daily-statistics request accepts `"grid": ["1.0", "1.0"]`. The server regrids to the same 1° grid as 20CR (lat 90 to −90, lon 0–359), so nothing needs regridding locally.
   - **Measured size and speed:** 0.17 MB per variable per day at 1°; one request took 38 s, mostly queue time. Several variables fit in one request per statistic (mean, max, min), so 2016 onwards is about 3 requests a month × 131 months, roughly 7 GB.
   - **Access:** the Copernicus account, key (`~/.cdsapirc`, set with `infra/setup-cds.sh`) and ERA5 licence are done.
5. **Validation:** run `validate_station.py` on a few station-years to spot problems:
   - 1850 (sparse data)
   - 1950 and 2000 (20CR)
   - 2016 and 2024 (ERA5)
   - continuity across the 2015/2016 switch

## Daily update (automatic)

A **GitHub Actions** workflow on a daily schedule, around 14:00 UTC after ERA5T's usual noon release:

1. **ERA5T:** build the day from 5 days ago. Also re-try the previous 5 days in case one was late.
2. **GFS:** build each day between the newest ERA5T day and yesterday from NOMADS analyses.
   - Uses the 00, 06, 12 and 18 UTC analyses plus short forecasts for precipitation and highs and lows.
   - The GRIB filter downloads only the needed fields, a few MB a day.
3. **Upload and update:** upload the new files, update the manifest ranges, and delete GFS files that ERA5 has replaced.
4. **Monthly:** re-pull the month that just turned from ERA5T to final ERA5, about 2–3 months back. Differences are tiny, so this is optional.

Secrets, stored only in GitHub's encrypted secrets and never in code:
- the Copernicus CDS API key
- the R2 access key and secret

Run time is about 5–10 minutes a day, which is free on a public repo and about 300 of the 2,000 free minutes a month on a private one.

## Front-end changes

- **Data location:** `DATA_ROOT` points at the R2 domain, and `?data=local` uses `site/data/` for development.
- **Date ranges:** `hasMap` reads the manifest's ranges instead of years.
- **Fields:** each source has its own field list. Uncertainty controls hide when a source has no spread.
- **Labels:**
  - The source shows in the credits line and the place report ("Map: ERA5" / "Map: 20CRv3" / "Map: GFS, preliminary").
  - The pre-1940 report note becomes source-aware.
- **Caching:** add the cache headers so visitors always get the newest JavaScript (the stale-module issue seen in testing). The site files go in `_headers` on Pages.
- **Wording:** the "No map for this date yet" notice disappears except for today and for gaps.

## Decisions for you

- **A. Start year:** 1836 (official start, recommended), or 1806 (the extension exists, but it's very uncertain; the uncertainty veil would show this honestly).
- **B. 1940–2015:**
  - 20CR, as planned above (recommended): one pipeline, keeps uncertainty, much smaller ERA5 download.
  - Or ERA5 from 1940, for sharper modern maps. That's about 7× more ERA5 to download, and two sources overlap.
- **C. Last few days:**
  - GFS preliminary maps (recommended, built as the final step).
  - Or accept that the map runs 5 days behind (the place report still covers yesterday).
- **D. Daily job:** GitHub Actions (recommended), or a scheduled job on the Mac, which only runs when the Mac is awake.

## What you'll need to set up (I can't create accounts)

1. **Copernicus Climate Data Store account:** accept the ERA5 licence, then paste the API key into `~/.cdsapirc` on the Mac. I'll walk you through it.
2. **Cloudflare R2:** enable it (it may ask for a payment method) and create an API token for the bucket. The custom domain needs prib.is's DNS in Cloudflare.
3. **GitHub:** the repo (public or private) and its Actions secrets. It also needs `gh` and `wrangler` installed, plus `rclone` and `eccodes` (for reading GFS GRIB files). I can install those with Homebrew.

## Order of work

1. ✅ Pipeline: year-aware fetch, `backfill.py` and the manifest-v4 format, then run 1836–1840 locally as a test.
2. ✅ Front end: source-aware manifest, `DATA_ROOT` and the cache headers.
3. ✅ R2 bucket and domain, then upload the test years and check the live site reading from R2.
4. ⏳ Full 20CR backfill overnight (running since 16 Nov 2026, 21:06), then validation.
5. ERA5 script ✅, test month ✅ (January 2016 against Central Park: highs and lows within about 2 °C, every wet day caught, the blizzard shown as heavy snow), backfill 2016 onwards ⏳.
6. GFS preliminary days.
7. GitHub repo and the Actions daily job *(needs you)*, and deploy the site to weather.prib.is.

Steps 1, 2, 4 (once R2 exists) and 6 need nothing from you.
