"""Map days from 2016 on, from NOAA's NCEP/NCAR Reanalysis 1.

Usage:  .venv/bin/python pipeline/ncep.py [first_year] [last_year] [--upload] [--keep]
        (default: 2016 to this year)

NOAA PSL publishes this reanalysis as small yearly netCDF files on the same server as
20CRv3, so a year downloads in under a minute with no queue. PSL's copy ends on
17 March 2026; later days come from GFS (pipeline/gfs.py).

For each year it downloads the files (about 150 MB), puts them on the site's 1-degree
grid, writes the same day files as the other sources under data/out/ncep/, checks
them, uploads them and updates the manifest. Finished days are recorded in
data/ncep-state.json, so a stopped run picks up where it left off. To stop cleanly
after the current year:  touch data/ncep.stop

What differs from 20CR:
  - The source grid is coarser (about 1.9 degrees; pressure 2.5 degrees). Values are
    interpolated to 1 degree, so maps look smoother than 20CR's.
  - No ensemble, so no uncertainty fields.
  - Snow share: the share of the day's precipitation that fell in 6-hour periods with
    a 2 m temperature at or below 1 degC (the files have no snowfall field).
  - Freezing rain: not available (0).
  - Snow depth: water equivalent of the snow on the ground, turned into a depth with
    a typical density of 250 kg/m3. Rough.
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from pathlib import Path

import numpy as np
import xarray as xr

import build_days as bd
from fetch import download

ROOT = bd.ROOT
RAW = ROOT / "data" / "raw" / "ncep"
STATE = ROOT / "data" / "ncep-state.json"
LOG = ROOT / "data" / "ncep.log"
STOP = ROOT / "data" / "ncep.stop"
SOURCE = "ncep"
FIRST_YEAR = 2016
BASE = "https://downloads.psl.noaa.gov/Datasets"
IMMUTABLE = "public, max-age=31536000, immutable"
SNOW_BELOW_K = 274.15        # 1 degC
SNOW_DENSITY = 250.0         # kg/m3, settled snow

SOURCE_META = {
    "name": "NCEP/NCAR Reanalysis 1 (daily averages)",
    "short": "NCEP/NCAR Reanalysis",
    "provider": "NOAA Physical Sciences Laboratory, Boulder, Colorado, USA",
    "url": "https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html",
    "license": "Public domain (US Government work)",
    "citation": "Kalnay, E., et al. (1996). The NCEP/NCAR 40-year reanalysis project. "
                "Bull. Amer. Meteor. Soc., 77, 437-471.",
    "spread": False,
    "preliminary": False,
}

# local name -> (remote path, netCDF variable)
FILES = {
    "slp.nc":      ("ncep.reanalysis.dailyavgs/surface/slp.{y}.nc", "slp"),
    "air.nc":      ("ncep.reanalysis.dailyavgs/surface_gauss/air.2m.gauss.{y}.nc", "air"),
    "tmax.nc":     ("ncep.reanalysis.dailyavgs/surface_gauss/tmax.2m.gauss.{y}.nc", "tmax"),
    "tmin.nc":     ("ncep.reanalysis.dailyavgs/surface_gauss/tmin.2m.gauss.{y}.nc", "tmin"),
    "prate.nc":    ("ncep.reanalysis.dailyavgs/surface_gauss/prate.sfc.gauss.{y}.nc", "prate"),
    "uwnd.nc":     ("ncep.reanalysis.dailyavgs/surface_gauss/uwnd.10m.gauss.{y}.nc", "uwnd"),
    "vwnd.nc":     ("ncep.reanalysis.dailyavgs/surface_gauss/vwnd.10m.gauss.{y}.nc", "vwnd"),
    "weasd.nc":    ("ncep.reanalysis.dailyavgs/surface_gauss/weasd.sfc.gauss.{y}.nc", "weasd"),
    "tcdc.nc":     ("ncep.reanalysis.dailyavgs/other_gauss/tcdc.eatm.gauss.{y}.nc", "tcdc"),
    # 6-hourly, for the snow share
    "air6.nc":     ("ncep.reanalysis/surface_gauss/air.2m.gauss.{y}.nc", "air"),
    "prate6.nc":   ("ncep.reanalysis/surface_gauss/prate.sfc.gauss.{y}.nc", "prate"),
}

# Same ids, units and storage steps as 20CR (build_days.FIELDS / DETAIL_FIELDS).
MAP_FIELDS = [
    dict(id="prmsl", units="hPa", scale=0.1, offset=1000.0, name="Sea-level pressure (daily mean)"),
    dict(id="t2m", units="°C", scale=0.1, offset=0.0, name="2 m air temperature (daily mean)"),
]
DETAIL_FIELDS = [
    dict(id="tmax", units="°C", scale=0.2, offset=0.0, name="Daily maximum 2 m temperature"),
    dict(id="tmin", units="°C", scale=0.2, offset=0.0, name="Daily minimum 2 m temperature"),
    dict(id="precip", units="mm", scale=0.1, offset=0.0, name="Total precipitation for the day"),
    dict(id="snow_frac", units="fraction", scale=0.01, offset=0.0,
         name="Share of the precipitation that fell at or below 1 °C (estimate of the snow share)"),
    dict(id="frz_frac", units="fraction", scale=0.01, offset=0.0, name="Freezing rain (not available from this source: 0)"),
    dict(id="cloud", units="%", scale=5.0, offset=0.0, name="Total cloud cover (daily mean)"),
    dict(id="u10", units="m/s", scale=0.5, offset=0.0, name="10 m eastward wind (daily mean)"),
    dict(id="v10", units="m/s", scale=0.5, offset=0.0, name="10 m northward wind (daily mean)"),
    dict(id="snow_depth", units="cm", scale=0.5, offset=0.0, name="Snow depth on the ground (estimated from its water content)"),
]

LAT = np.arange(90.0, -90.5, -1.0)
LON = np.arange(-180.0, 180.0, 1.0)


def log(msg: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def load_state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {"days": []}


def mark_done(dates: list[str]) -> list[str]:
    state = load_state()
    state["days"] = sorted(set(state["days"]) | set(dates))
    STATE.write_text(json.dumps(state) + "\n")
    return state["days"]


# ---- fetch -----------------------------------------------------------------------------

def fetch_year(year: int, refresh: bool = False) -> Path:
    folder = RAW / str(year)
    if refresh:
        shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as pool:
        sizes = list(pool.map(lambda kv: download(f"{BASE}/{kv[1][0].format(y=year)}", folder / kv[0]),
                              FILES.items()))
    secs = time.time() - t0
    log(f"{year}: fetched {sum(sizes) / 1e6:.0f} MB in {secs:.0f}s")
    return folder


# ---- convert --------------------------------------------------------------------------

def _weights(src: np.ndarray, want: np.ndarray):
    """For ascending `src`, the lower index and upper weight that linearly interpolate to `want`."""
    i = np.clip(np.searchsorted(src, want, side="right") - 1, 0, src.size - 2)
    w = (want - src[i]) / (src[i + 1] - src[i])
    return i, w


def to_grid(da: xr.DataArray) -> np.ndarray:
    """(time, lat, lon) on any regular or Gaussian grid -> float64 on the 1-degree display grid.
    Linear in both directions; wraps around the date line; rows beyond the source's
    last latitude (the poles) repeat the nearest row."""
    extra = [d for d in da.dims if d not in ("time", "lat", "lon")]   # e.g. a one-value "level"
    da = da.squeeze(extra, drop=True).transpose("time", "lat", "lon").sortby("lat").sortby("lon")
    v = da.values.astype("float64")
    lon = da.lon.values.astype("float64")
    v = np.concatenate([v, v[:, :, :1]], axis=2)             # wrap: first column again at +360
    lon = np.append(lon, lon[0] + 360)
    i, w = _weights(lon, LON % 360)
    v = v[:, :, i] * (1 - w) + v[:, :, i + 1] * w
    lat = da.lat.values.astype("float64")
    j, u = _weights(lat, np.clip(LAT, lat[0], lat[-1]))
    return v[:, j, :] * (1 - u)[None, :, None] + v[:, j + 1, :] * u[None, :, None]


def open_var(folder: Path, name: str) -> xr.DataArray:
    """A file's variable. Daily files take their dates from the temperature file: a few of
    NOAA's files have a corrupt time value (tcdc 2023), though the data are in order."""
    if name in ("air.nc", "air6.nc", "prate6.nc"):
        return xr.open_dataset(folder / name)[FILES[name][1]]
    time = xr.open_dataset(folder / "air.nc").time
    da = xr.open_dataset(folder / name, decode_times=False)[FILES[name][1]]
    if da.sizes["time"] != time.size:
        raise ValueError(f"{name}: {da.sizes['time']} days, but the temperature file has {time.size}")
    return da.assign_coords(time=time.values)


def patch_bad_days(da: xr.DataArray, name: str) -> xr.DataArray:
    """A few days in NOAA's files hold fill values instead of data (tcdc, 21 Dec 2023).
    Replace such a day with the average of the nearest good day on each side, and say so."""
    v = da.values.astype("float64")
    bad = ~np.isfinite(v) | (np.abs(v) > 1e30)
    bad_days = np.where(bad.reshape(v.shape[0], -1).any(axis=1))[0]
    if bad_days.size == 0:
        return da
    good = np.setdiff1d(np.arange(v.shape[0]), bad_days)
    if bad_days.size > 3 or good.size == 0:
        raise ValueError(f"{name}: {bad_days.size} days of fill values")
    for i in bad_days:
        near = [g for g in (good[good < i][-1:], good[good > i][:1]) if g.size]
        v[i] = np.mean([v[g[0]] for g in near], axis=0)
        log(f"{name}: {str(da.time.values[i])[:10]} is fill values in NOAA's file; used the average of the days around it")
    return da.copy(data=v)


def to_fields(folder: Path, want: list[str]):
    """One year's files -> ({map id: array}, {detail id: array}, dates) for the days in `want`."""
    def day(name):
        da = patch_bad_days(open_var(folder, name), name)
        return da.sel(time=da.time.dt.strftime("%Y-%m-%d").isin(want))

    air = day("air.nc")
    dates = [str(t)[:10] for t in air.time.values]
    if not dates:
        return {}, {}, []

    # Snow share, worked out on the display grid so it agrees with the temperatures shown
    # there: the share of the day's precipitation that fell in cold 6-hour periods.
    air6, prate6 = open_var(folder, "air6.nc"), open_var(folder, "prate6.nc")
    share = np.zeros((len(dates), LAT.size, LON.size))
    for month in sorted({d[:7] for d in dates}):
        t = to_grid(air6.sel(time=month))
        p = np.maximum(to_grid(prate6.sel(time=month)), 0)
        days6 = np.array([str(x)[:10] for x in air6.sel(time=month).time.values])
        for k, d in enumerate(dates):
            if d[:7] != month:
                continue
            sel = days6 == d
            wet = p[sel].sum(axis=0)
            cold = np.where(t[sel] <= SNOW_BELOW_K, p[sel], 0).sum(axis=0)
            share[k] = np.divide(cold, wet, out=np.zeros_like(wet), where=wet > 0)

    precip = np.maximum(to_grid(day("prate.nc")) * 86400, 0)          # kg/m2/s -> mm a day
    snow_frac = np.where(precip >= 0.1, np.clip(share, 0, 1), 0.0)
    weasd = np.nan_to_num(to_grid(day("weasd.nc")))                   # kg/m2 of water
    map_vals = {"prmsl": to_grid(day("slp.nc")) / 100, "t2m": to_grid(air) - 273.15}
    detail_vals = {
        "tmax": to_grid(day("tmax.nc")) - 273.15, "tmin": to_grid(day("tmin.nc")) - 273.15,
        "precip": precip, "snow_frac": snow_frac, "frz_frac": np.zeros_like(precip),
        "cloud": np.clip(to_grid(day("tcdc.nc")), 0, 100),
        "u10": to_grid(day("uwnd.nc")), "v10": to_grid(day("vwnd.nc")),
        "snow_depth": np.clip(weasd / SNOW_DENSITY * 100, 0, 3000),   # cm
    }
    for name, vals in {**map_vals, **detail_vals}.items():
        if vals.shape != (len(dates), LAT.size, LON.size):
            raise ValueError(f"{name}: got {vals.shape} for {len(dates)} days (a file is missing days)")
        if np.isnan(vals).any():
            raise ValueError(f"{name}: missing values")
    return map_vals, detail_vals, dates


def write_days(vals: dict, fields: list[dict], kind: str, dates: list[str]) -> int:
    arrays = [bd.quantize(vals[f["id"]], f["scale"], f["offset"]) for f in fields]
    total = 0
    for i, d in enumerate(dates):
        folder = bd.OUT / SOURCE / kind / d[:4]
        folder.mkdir(parents=True, exist_ok=True)
        blob = gzip.compress(bd.shuffle(np.stack([a[i] for a in arrays])), compresslevel=9, mtime=0)
        (folder / f"{d}.bin.gz").write_bytes(blob)
        total += len(blob)
    return total


def verify(vals: dict, fields: list[dict], kind: str, dates: list[str]) -> None:
    """Decode the first, middle and last day exactly as the site does and compare."""
    for i in sorted({0, len(dates) // 2, len(dates) - 1}):
        path = bd.OUT / SOURCE / kind / dates[i][:4] / f"{dates[i]}.bin.gz"
        raw = bd.unshuffle(gzip.decompress(path.read_bytes())).reshape(len(fields), -1)
        for f, block in zip(fields, raw):
            got = block.astype("float64") * f["scale"] + f["offset"]
            err = np.max(np.abs(got - vals[f["id"]][i].ravel()))
            if (block == bd.NODATA).any() or err > f["scale"] / 2 + 1e-6:
                raise ValueError(f"{dates[i]} {kind}/{f['id']}: round-trip error {err}")


# ---- upload ---------------------------------------------------------------------------

def rclone(*args: str) -> None:
    if not shutil.which("rclone"):
        raise RuntimeError("rclone is not installed (brew install rclone)")
    subprocess.run(["rclone", *args], check=True)


def upload_dates(dates: list[str], remote: str) -> None:
    for kind in ("days", "detail"):
        for year in sorted({d[:4] for d in dates}):
            rclone("copy", str(bd.OUT / SOURCE / kind / year), f"{remote}/{SOURCE}/{kind}/{year}",
                   "--transfers", "16", "--s3-no-check-bucket",
                   "--header-upload", f"Cache-Control: {IMMUTABLE}",
                   "--header-upload", "Content-Type: application/octet-stream")


def upload_manifest(remote: str) -> None:
    with bd.manifest_lock():
        rclone("copyto", str(bd.MANIFEST), f"{remote}/manifest.json", "--s3-no-check-bucket",
               "--header-upload", "Cache-Control: public, max-age=300",
               "--header-upload", "Content-Type: application/json")


# ---- run ------------------------------------------------------------------------------

def do_year(year: int, upload: bool, remote: str, keep: bool) -> int:
    done = set(load_state()["days"])
    this_year = year == date.today().year
    folder = fetch_year(year, refresh=this_year)      # the current year's files grow
    in_file = [str(t)[:10] for t in open_var(folder, "air.nc").time.values]
    want = [d for d in in_file if d not in done]
    if not want:
        log(f"{year}: nothing new (file ends {in_file[-1]})")
        if not keep:
            shutil.rmtree(folder, ignore_errors=True)
        return 0
    map_vals, detail_vals, dates = to_fields(folder, want)
    size = write_days(map_vals, MAP_FIELDS, "days", dates) + write_days(detail_vals, DETAIL_FIELDS, "detail", dates)
    verify(map_vals, MAP_FIELDS, "days", dates)
    verify(detail_vals, DETAIL_FIELDS, "detail", dates)
    if upload:
        upload_dates(dates, remote)
    all_done = mark_done(dates)
    bd.update_source(SOURCE, SOURCE_META, MAP_FIELDS, DETAIL_FIELDS, LAT, LON,
                     ranges=bd.ranges_from_dates(all_done))
    if upload:
        upload_manifest(remote)
    if not keep:
        shutil.rmtree(folder, ignore_errors=True)
        if upload:
            for kind in ("days", "detail"):
                for d in dates:
                    (bd.OUT / SOURCE / kind / d[:4] / f"{d}.bin.gz").unlink(missing_ok=True)
    log(f"{year}: {len(dates)} days built and verified, {dates[0]}..{dates[-1]} ({size / 1e6:.1f} MB)"
        + (", uploaded" if upload else ""))
    return len(dates)


def run(first: int, last: int, upload: bool, remote: str, keep: bool) -> None:
    log(f"NCEP/NCAR Reanalysis {first}..{last}, upload={'on' if upload else 'off'}")
    total = 0
    for year in range(first, last + 1):
        if STOP.exists():
            STOP.unlink()
            log("stop file found; stopping cleanly")
            return
        total += do_year(year, upload, remote, keep)
    log(f"NCEP/NCAR run finished: {total} days")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("first", nargs="?", type=int, default=FIRST_YEAR)
    ap.add_argument("last", nargs="?", type=int, default=date.today().year)
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--remote", default="r2:weatherthen-data")
    ap.add_argument("--keep", action="store_true", help="keep downloads and built files locally")
    a = ap.parse_args()
    try:
        run(max(a.first, FIRST_YEAR), a.last, a.upload, a.remote, a.keep)
    except KeyboardInterrupt:
        log("interrupted; re-run to resume")
    except Exception as e:  # noqa: BLE001
        log(f"error: {str(e)[:500]}; stopped (re-run to resume)")
        raise
