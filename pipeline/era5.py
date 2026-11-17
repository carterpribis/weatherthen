"""ERA5 daily maps (2016 onwards) from the Copernicus Climate Data Store.

Usage:
  .venv/bin/python pipeline/era5.py 2016-01-01 2016-01-31            # one test month, local only
  .venv/bin/python pipeline/era5.py 2016-01-01 --upload              # backfill to 6 days ago, upload to R2
  .venv/bin/python pipeline/era5.py --recent --upload                 # daily job: any missing recent days

Needs ~/.cdsapirc (see infra/setup-cds.sh) and the ERA5 licence accepted on the CDS site.

Uses ERA5 hourly data ("reanalysis-era5-single-levels"), regridded by the CDS to the same
1-degree grid as 20CRv3, and computes the daily values here. (The CDS "daily statistics"
product does that server-side, but its queue was far slower.) The CDS asks for requests
to be sent one at a time, and each request waits hours in its queue whatever its size, so
a whole year goes in one pair of requests, sent strictly in sequence:
  request "hourly":  2 m temperature, precipitation, snowfall at every hour
                     -> daily mean/max/min temperature, daily totals
  request "3hourly": pressure, cloud, wind, snow depth and density every 3 hours
                     -> daily means
Output uses the same per-day file format and field ids as 20CR, so the site treats both
sources alike. Differences: no ensemble spread (no ± or uncertainty layer), snow share =
snowfall / precipitation, freezing rain not available (0). Daily totals sum the hourly
amounts stamped 00:00-23:00 UTC (each covers the hour before), i.e. 23:00 the day before
to 23:00; close enough for a daily map.

A request ("chunk") covers every complete month still missing in one year; a partly
missing month (the latest one, usually) gets its own chunk with just those days. Each
downloaded chunk is then converted a month at a time, so memory stays small.

Resumable: built days are recorded in data/era5-state.json, which is also what the
manifest's ERA5 date ranges are rebuilt from. Progress goes to data/era5.log. Stops at
the first error so a bad request never burns through the queue unattended.
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_days as bd  # noqa: E402

ROOT = bd.ROOT
OUT = bd.OUT
RAW = ROOT / "data" / "raw" / "era5"
STATE = ROOT / "data" / "era5-state.json"
LOG = ROOT / "data" / "era5.log"
STOP = ROOT / "data" / "era5.stop"
SOURCE = "era5"
DATASET = "reanalysis-era5-single-levels"
FIRST_DAY = date(2016, 1, 1)
LAG_DAYS = 6          # ERA5T is ~5 days behind; one day of slack
IMMUTABLE = "public, max-age=31536000, immutable"

SOURCE_META = {
    "name": "ERA5 reanalysis (ECMWF), Copernicus Climate Change Service",
    "short": "ERA5",
    "provider": "Copernicus Climate Change Service (C3S) / ECMWF",
    "url": "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels",
    "license": "Copernicus licence; generated using Copernicus Climate Change Service information",
    "citation": "Hersbach, H., et al. (2020). The ERA5 global reanalysis. Q. J. R. Meteorol. Soc., 146, 1999-2049.",
    "spread": False,
    "preliminary": False,
}

# CDS variable -> netCDF short name, and the hours requested.
REQUESTS = {
    "hourly": ({"2m_temperature": "t2m", "total_precipitation": "tp", "snowfall": "sf"},
               [f"{h:02d}:00" for h in range(24)]),
    "3hourly": ({"mean_sea_level_pressure": "msl", "total_cloud_cover": "tcc",
                 "10m_u_component_of_wind": "u10", "10m_v_component_of_wind": "v10",
                 "snow_depth": "sd", "snow_density": "rsn"},
                [f"{h:02d}:00" for h in range(0, 24, 3)]),
}

# Same ids, units and storage steps as 20CR (build_days.FIELDS / DETAIL_FIELDS).
MAP_FIELDS = [
    dict(id="prmsl", units="hPa", scale=0.1, offset=1000.0, name="Sea-level pressure (daily mean)"),
    dict(id="t2m", units="°C", scale=0.1, offset=0.0, name="2 m air temperature (daily mean)"),
]
DETAIL_FIELDS = [
    dict(id="tmax", units="°C", scale=0.2, offset=0.0, name="Daily maximum 2 m temperature (hourly values)"),
    dict(id="tmin", units="°C", scale=0.2, offset=0.0, name="Daily minimum 2 m temperature (hourly values)"),
    dict(id="precip", units="mm", scale=0.1, offset=0.0, name="Total precipitation for the day"),
    dict(id="snow_frac", units="fraction", scale=0.01, offset=0.0, name="Share of the precipitation that fell as snow"),
    dict(id="frz_frac", units="fraction", scale=0.01, offset=0.0, name="Freezing rain (not available from ERA5 here: 0)"),
    dict(id="cloud", units="%", scale=5.0, offset=0.0, name="Total cloud cover (daily mean)"),
    dict(id="u10", units="m/s", scale=0.5, offset=0.0, name="10 m eastward wind (daily mean)"),
    dict(id="v10", units="m/s", scale=0.5, offset=0.0, name="10 m northward wind (daily mean)"),
    dict(id="snow_depth", units="cm", scale=0.5, offset=0.0, name="Snow depth on the ground"),
]


def log(msg: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


# ---- state ---------------------------------------------------------------------------

def load_state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {"days": []}


def mark_done(dates: list[str]) -> list[str]:
    state = load_state()
    state["days"] = sorted(set(state["days"]) | set(dates))
    STATE.write_text(json.dumps(state) + "\n")
    return state["days"]


# ---- fetch -----------------------------------------------------------------------------

def cds_client():
    """Copernicus client from ~/.cdsapirc (the key is never printed or logged)."""
    from ecmwf.datastores import Client  # imported here so the rest of the module works without it

    cfg = dict(line.split(":", 1) for line in Path.home().joinpath(".cdsapirc").read_text().splitlines() if ":" in line)
    return Client(url=cfg["url"].strip(), key=cfg["key"].strip(), progress=False,
                  sleep_max=120, timeout=600, maximum_tries=500, retry_after=120)


def submit_or_reattach(req: dict, job_file: Path, label: str):
    """Send a request, or pick up the one a stopped run left queued (its id is saved in job_file),
    so a restart never loses its place in the queue or trips the one-request-at-a-time limit."""
    client = cds_client()
    if job_file.exists():
        request_id = job_file.read_text().strip()
        try:
            remote = client.get_remote(request_id)
            status = remote.status
        except Exception as e:  # noqa: BLE001 (gone or expired: send a new one)
            status = f"unavailable ({str(e)[:80]})"
        if status in ("accepted", "running", "successful"):
            log(f"{label}: picked up request already in the queue ({status})")
            return remote
        log(f"{label}: earlier request {status}; sending a new one")
    remote = client.submit(DATASET, req)
    job_file.write_text(remote.request_id + "\n")
    log(f"{label}: requested")
    return remote


def fetch(kind: str, year: int, months: list[int], days: list[int], folder: Path, label: str) -> xr.Dataset:
    """One CDS request -> lazy Dataset with dims (time, lat, lon). Cached on disk.

    The CDS takes the cross product of months x days and skips dates that don't exist."""
    names, hours = REQUESTS[kind]
    target = folder / f"{kind}.download"
    if not target.exists():
        req = {
            "product_type": ["reanalysis"], "variable": list(names),
            "year": [str(year)], "month": [f"{m:02d}" for m in months], "day": [f"{d:02d}" for d in days],
            "time": hours, "data_format": "netcdf", "download_format": "unarchived",
            "grid": ["1.0", "1.0"],
        }
        part = target.with_suffix(".part")
        t0 = time.time()
        while True:
            remote = submit_or_reattach(req, folder / f"{kind}.job", f"{label} {kind}")
            try:
                remote.download(str(part))        # waits in the queue, then downloads
                break
            except Exception as e:  # noqa: BLE001
                if "Maximum number queued" not in str(e):
                    raise
                # Another of our requests still holds the queue slot (e.g. one left by a run
                # that died while waiting): wait for it to clear, then send ours again.
                (folder / f"{kind}.job").unlink(missing_ok=True)
                log(f"{label} {kind}: Copernicus is still busy with an earlier request; retrying in 10 min")
                time.sleep(600)
        part.rename(target)
        (folder / f"{kind}.job").unlink(missing_ok=True)
        log(f"{label} {kind}: downloaded {target.stat().st_size / 1e6:.0f} MB, {(time.time() - t0) / 60:.0f} min after request")
    # Instantaneous and accumulated variables can arrive as a zip of two netCDF files.
    files = [target]
    if zipfile.is_zipfile(target):
        unzip = folder / f"{kind}.unzipped"
        if not unzip.exists():
            with zipfile.ZipFile(target) as z:
                z.extractall(unzip)
        files = sorted(unzip.rglob("*.nc"))
    ds = xr.merge([xr.open_dataset(f) for f in files], compat="override")
    ds = ds.rename({k: v for k, v in (("valid_time", "time"), ("latitude", "lat"), ("longitude", "lon"))
                    if k in ds.dims or k in ds.coords})
    if "expver" in ds.dims:  # ERA5 and ERA5T mixed: take whichever is present
        ds = ds.isel(expver=0).combine_first(ds.isel(expver=-1))
    drop = [c for c in ds.coords if c not in ("time", "lat", "lon")]
    ds = ds.drop_vars(drop)
    missing = set(names.values()) - set(ds.data_vars)
    if missing:
        raise ValueError(f"{kind}: missing variables {sorted(missing)} in CDS response")
    return ds


# ---- convert --------------------------------------------------------------------------

def to_fields(hourly: xr.Dataset, three: xr.Dataset):
    """Hourly and 3-hourly CDS data -> ({map id: array}, {detail id: array}, dates, lat, lon)."""
    def daily(da, how):
        r = da.resample(time="1D")
        return getattr(r, how)()

    def g(da):  # -> (day, lat, lon) float64 on the display grid
        return bd.to_display_grid(da).values.astype("float64")

    t2m = hourly["t2m"]
    mean_t = daily(t2m, "mean")
    disp = bd.to_display_grid(mean_t)
    tp = g(daily(hourly["tp"], "sum")) * 1000            # m of water -> mm
    sf = g(daily(hourly["sf"], "sum")) * 1000
    rsn = g(daily(three["rsn"], "mean"))
    sd = g(daily(three["sd"], "mean"))                    # m of water equivalent
    with np.errstate(divide="ignore", invalid="ignore"):
        snow_frac = np.where(tp >= 0.1, np.clip(sf / tp, 0, 1), 0.0)
        snow_depth = np.where((rsn > 1) & (sd > 0), sd * 1000 / rsn * 100, 0.0)   # cm
    map_vals = {"prmsl": g(daily(three["msl"], "mean")) / 100, "t2m": g(mean_t) - 273.15}
    detail_vals = {
        "tmax": g(daily(t2m, "max")) - 273.15, "tmin": g(daily(t2m, "min")) - 273.15,
        "precip": np.maximum(tp, 0), "snow_frac": snow_frac, "frz_frac": np.zeros_like(tp),
        "cloud": g(daily(three["tcc"], "mean")) * 100,
        "u10": g(daily(three["u10"], "mean")), "v10": g(daily(three["v10"], "mean")),
        "snow_depth": np.clip(np.nan_to_num(snow_depth), 0, 3000),
    }
    dates = [str(t)[:10] for t in disp.time.values]
    return map_vals, detail_vals, dates, disp.lat.values, disp.lon.values


def write_days(vals: dict, fields: list[dict], kind: str, dates: list[str]) -> int:
    arrays = [bd.quantize(vals[f["id"]], f["scale"], f["offset"]) for f in fields]
    total = 0
    for i, d in enumerate(dates):
        folder = OUT / SOURCE / kind / d[:4]
        folder.mkdir(parents=True, exist_ok=True)
        blob = gzip.compress(bd.shuffle(np.stack([a[i] for a in arrays])), compresslevel=9, mtime=0)
        (folder / f"{d}.bin.gz").write_bytes(blob)
        total += len(blob)
    return total


def verify(vals: dict, fields: list[dict], kind: str, dates: list[str]) -> None:
    """Decode the first and last day exactly as the site does and compare."""
    for i in (0, len(dates) - 1):
        path = OUT / SOURCE / kind / dates[i][:4] / f"{dates[i]}.bin.gz"
        raw = bd.unshuffle(gzip.decompress(path.read_bytes())).reshape(len(fields), -1)
        for f, block in zip(fields, raw):
            got = block.astype("float64") * f["scale"] + f["offset"]
            got[block == bd.NODATA] = np.nan
            ref = vals[f["id"]][i].ravel()
            err = np.nanmax(np.abs(got - ref))
            if np.isnan(ref).sum() != np.isnan(got).sum() or err > f["scale"] / 2 + 1e-6:
                raise ValueError(f"{dates[i]} {kind}/{f['id']}: round-trip error {err}")


# ---- upload ---------------------------------------------------------------------------

def rclone(*args: str) -> None:
    if not shutil.which("rclone"):
        raise RuntimeError("rclone is not installed (brew install rclone)")
    subprocess.run(["rclone", *args], check=True)


def upchunk_dates(dates: list[str], remote: str) -> None:
    for kind in ("days", "detail"):
        for year in sorted({d[:4] for d in dates}):
            src = OUT / SOURCE / kind / year
            include = [a for d in dates if d[:4] == year for a in ("--include", f"{d}.bin.gz")]
            rclone("copy", str(src), f"{remote}/{SOURCE}/{kind}/{year}", *include,
                   "--transfers", "16", "--s3-no-check-bucket",
                   "--header-upload", f"Cache-Control: {IMMUTABLE}",
                   "--header-upload", "Content-Type: application/octet-stream")


def upload_manifest(remote: str) -> None:
    with bd.manifest_lock():
        rclone("copyto", str(bd.MANIFEST), f"{remote}/manifest.json", "--s3-no-check-bucket",
               "--header-upload", "Cache-Control: public, max-age=300",
               "--header-upload", "Content-Type: application/json")


# ---- one chunk (one pair of requests) ----------------------------------------------

def build_month(hourly: xr.Dataset, three: xr.Dataset, year: int, month: int,
                upload: bool, remote: str, keep: bool) -> int:
    span = f"{year}-{month:02d}"
    h, t = hourly.sel(time=span).load(), three.sel(time=span).load()
    if h.sizes["time"] == 0 or t.sizes["time"] == 0:
        raise ValueError(f"{span}: no data in CDS response")
    map_vals, detail_vals, dates, lat, lon = to_fields(h, t)
    size = write_days(map_vals, MAP_FIELDS, "days", dates) + write_days(detail_vals, DETAIL_FIELDS, "detail", dates)
    verify(map_vals, MAP_FIELDS, "days", dates)
    verify(detail_vals, DETAIL_FIELDS, "detail", dates)
    if upload:
        upchunk_dates(dates, remote)
    done = mark_done(dates)
    bd.update_source(SOURCE, SOURCE_META, MAP_FIELDS, DETAIL_FIELDS, lat, lon,
                     ranges=bd.ranges_from_dates(done))
    if upload:
        upload_manifest(remote)
        if not keep:
            for kind in ("days", "detail"):
                for d in dates:
                    (OUT / SOURCE / kind / d[:4] / f"{d}.bin.gz").unlink(missing_ok=True)
    log(f"{span}: {len(dates)} days built and verified ({size / 1e6:.1f} MB)" + (", uploaded" if upload else ""))
    return len(dates)


def do_chunk(chunk: tuple[int, list[int], list[int]], upload: bool, remote: str, keep: bool) -> int:
    year, months, days = chunk
    label = chunk_label(chunk)
    folder = RAW / label
    folder.mkdir(parents=True, exist_ok=True)
    hourly = fetch("hourly", year, months, days, folder, label)       # strictly one request at a time
    three = fetch("3hourly", year, months, days, folder, label)
    n = sum(build_month(hourly, three, year, m, upload, remote, keep) for m in months)
    hourly.close()
    three.close()
    if not keep:
        shutil.rmtree(folder, ignore_errors=True)
    return n


def chunk_label(chunk: tuple[int, list[int], list[int]]) -> str:
    year, months, days = chunk
    if len(months) == 1:
        return f"{year}-{months[0]:02d}" + ("" if days == list(range(1, 32)) else f"-{days[0]:02d}..{days[-1]:02d}")
    return f"{year}-{months[0]:02d}..{months[-1]:02d}"


def plan(start: date, end: date) -> list[tuple[int, list[int], list[int]]]:
    """Requests to send: (year, months, days). Complete missing months of a year share one
    request; a partly missing month gets a request of its own for just those days."""
    have = set(load_state()["days"])
    todo: dict[tuple[int, int], list[int]] = {}
    d = start
    while d <= end:
        if d.isoformat() not in have:
            todo.setdefault((d.year, d.month), []).append(d.day)
        d += timedelta(days=1)
    full: dict[int, list[int]] = {}
    partial = []
    for (y, m), days in sorted(todo.items()):
        month_len = ((date(y + m // 12, m % 12 + 1, 1)) - date(y, m, 1)).days
        if len(days) == month_len:
            full.setdefault(y, []).append(m)
        else:
            partial.append((y, [m], days))
    chunks = [(y, ms, list(range(1, 32))) for y, ms in full.items()] + partial
    return sorted(chunks, key=lambda c: (c[0], c[1][0]))


def run(start: date, end: date, upload: bool, remote: str, keep: bool) -> None:
    chunks = plan(start, end)
    total = sum(len(chunk_dates(c)) for c in chunks)
    log(f"ERA5 {start}..{end}: {total} days in {len(chunks)} requests to do "
        f"({', '.join(chunk_label(c) for c in chunks)}), upload={'on' if upload else 'off'}")
    t0 = time.time()
    for n, chunk in enumerate(chunks, 1):
        if STOP.exists():
            STOP.unlink()
            log("stop file found; stopping cleanly")
            return
        do_chunk(chunk, upload, remote, keep)   # an error stops the run (re-run to resume)
        left = (len(chunks) - n) * (time.time() - t0) / n
        log(f"{n}/{len(chunks)} requests done; about {left / 3600:.1f} h left at this pace")
    log("ERA5 run finished")


def chunk_dates(chunk: tuple[int, list[int], list[int]]) -> list[date]:
    """The real dates a chunk covers."""
    year, months, days = chunk
    out = []
    for m in months:
        for d in days:
            try:
                out.append(date(year, m, d))
            except ValueError:
                pass
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("start", nargs="?", help="first day, YYYY-MM-DD (default 2016-01-01)")
    ap.add_argument("end", nargs="?", help=f"last day (default: {LAG_DAYS} days ago)")
    ap.add_argument("--recent", action="store_true", help="only the last 30 days (for the daily job)")
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--remote", default="r2:weatherthen-data")
    ap.add_argument("--keep", action="store_true", help="keep downloads and built files locally")
    a = ap.parse_args()
    last = date.today() - timedelta(days=LAG_DAYS)
    end = date.fromisoformat(a.end) if a.end else last
    start = (last - timedelta(days=30)) if a.recent else date.fromisoformat(a.start or FIRST_DAY.isoformat())
    try:
        run(max(start, FIRST_DAY), min(end, last), a.upload, a.remote, a.keep)
    except KeyboardInterrupt:
        log("interrupted; re-run to resume")
    except Exception as e:  # noqa: BLE001
        log(f"error: {str(e)[:500]}; stopped (re-run to resume)")
        raise
