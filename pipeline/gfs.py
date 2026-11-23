"""Map days after NOAA's reanalysis ends, from NOAA's GFS weather model.

Usage:  .venv/bin/python pipeline/gfs.py [first_day] [last_day] [--upload] [--keep]
        .venv/bin/python pipeline/gfs.py --recent 10 --upload      (the daily job)
        default: 2026-03-18 (the day after pipeline/ncep.py's last day) to yesterday (UTC)

NOAA publishes every GFS run in a public bucket on AWS, with an index that says where
each field sits in the file, so only the fields needed are downloaded (about 1.5 MB a
day instead of 500 MB). No account, no queue. The 1-degree files are already on the
site's grid.

For a day it uses the four runs that start at 00, 06, 12 and 18 UTC:
  - the analysis and the 3-hour forecast of each run for pressure, temperature and
    wind (eight values through the day, averaged)
  - the 6-hour forecast of each run for the day's rain and snow, highs and lows and
    cloud (four 6-hour periods that together cover the day)

Finished days are recorded in data/gfs-state.json, so a stopped run picks up where it
left off. A day whose files are not all published yet is skipped and tried again on
the next run. To stop cleanly:  touch data/gfs.stop
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import eccodes
import numpy as np

import build_days as bd

ROOT = bd.ROOT
STATE = ROOT / "data" / "gfs-state.json"
LOG = ROOT / "data" / "gfs.log"
STOP = ROOT / "data" / "gfs.stop"
SOURCE = "gfs"
FIRST_DAY = date(2026, 3, 18)
BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
IMMUTABLE = "public, max-age=31536000, immutable"
UPLOAD_EVERY = 10            # days per upload and manifest update

SOURCE_META = {
    "name": "NOAA Global Forecast System (GFS): analyses and short forecasts",
    "short": "NOAA GFS",
    "provider": "NOAA National Centers for Environmental Prediction",
    "url": "https://registry.opendata.aws/noaa-gfs-bdp-pds/",
    "license": "Public domain (US Government work)",
    "citation": "NOAA/NCEP Global Forecast System, 1-degree fields from the NOAA Open Data Dissemination archive.",
    "spread": False,
    "preliminary": False,
}

# forecast hour -> {our name: the index line's "FIELD:level:period" text}
WANT = {
    0: {"prmsl": "PRMSL:mean sea level:anl", "t2m": "TMP:2 m above ground:anl",
        "u10": "UGRD:10 m above ground:anl", "v10": "VGRD:10 m above ground:anl",
        "snod": "SNOD:surface:anl"},
    3: {"prmsl": "PRMSL:mean sea level:3 hour fcst", "t2m": "TMP:2 m above ground:3 hour fcst",
        "u10": "UGRD:10 m above ground:3 hour fcst", "v10": "VGRD:10 m above ground:3 hour fcst"},
    6: {"tmax": "TMAX:2 m above ground:0-6 hour max fcst", "tmin": "TMIN:2 m above ground:0-6 hour min fcst",
        "apcp": "APCP:surface:0-6 hour acc fcst", "csnow": "CSNOW:surface:0-6 hour ave fcst",
        "cfrzr": "CFRZR:surface:0-6 hour ave fcst", "tcdc": "TCDC:entire atmosphere:0-6 hour ave fcst"},
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
    dict(id="snow_frac", units="fraction", scale=0.01, offset=0.0, name="Share of the precipitation that fell as snow"),
    dict(id="frz_frac", units="fraction", scale=0.01, offset=0.0, name="Share of the precipitation that fell as freezing rain"),
    dict(id="cloud", units="%", scale=5.0, offset=0.0, name="Total cloud cover (daily mean)"),
    dict(id="u10", units="m/s", scale=0.5, offset=0.0, name="10 m eastward wind (daily mean)"),
    dict(id="v10", units="m/s", scale=0.5, offset=0.0, name="10 m northward wind (daily mean)"),
    dict(id="snow_depth", units="cm", scale=0.5, offset=0.0, name="Snow depth on the ground"),
]

LAT = np.arange(90.0, -90.5, -1.0)
LON = np.arange(-180.0, 180.0, 1.0)


class NotReady(Exception):
    """A file for the day is not published (yet)."""


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

def get(url: str, byte_range: tuple[int, int] | None = None, tries: int = 5) -> bytes:
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(url, headers={"User-Agent": "weatherthen-pipeline"})
        if byte_range:
            req.add_header("Range", f"bytes={byte_range[0]}-{byte_range[1]}")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise NotReady(url) from e
            err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        time.sleep(3 * attempt)
    raise RuntimeError(f"{url}: {err}")


def decode(msg: bytes) -> np.ndarray:
    """One GRIB message -> (181, 360) float64, north row first, longitudes -180..179."""
    h = eccodes.codes_new_from_message(msg)
    try:
        ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
        lat0, lon0 = eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees"), eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
        if (ni, nj, lat0, lon0) != (360, 181, 90.0, 0.0):
            raise ValueError(f"unexpected GFS grid {ni}x{nj} from {lat0},{lon0}")
        v = eccodes.codes_get_values(h).astype("float64").reshape(nj, ni)
        if eccodes.codes_get(h, "bitmapPresent"):
            v[v == eccodes.codes_get(h, "missingValue")] = np.nan
    finally:
        eccodes.codes_release(h)
    return np.roll(v, 180, axis=1)


def fetch_file(day: date, cycle: int, hour: int) -> dict[str, np.ndarray]:
    """The wanted fields of one GFS file, by our name."""
    url = f"{BUCKET}/gfs.{day:%Y%m%d}/{cycle:02d}/atmos/gfs.t{cycle:02d}z.pgrb2.1p00.f{hour:03d}"
    lines = get(url + ".idx").decode().strip().split("\n")
    starts = [int(l.split(":")[1]) for l in lines]
    out = {}
    for name, key in WANT[hour].items():
        hits = [i for i, l in enumerate(lines) if l.split(":", 3)[3].rstrip(":") == key]
        if not hits:
            raise ValueError(f"{url}: no '{key}' in the index")
        i = hits[0]
        end = starts[i + 1] - 1 if i + 1 < len(starts) else ""
        out[name] = decode(get(url, (starts[i], end)))
    return out


def fetch_day(day: date) -> dict[tuple[int, int], dict[str, np.ndarray]]:
    jobs = [(c, h) for c in (0, 6, 12, 18) for h in (0, 3, 6)]
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda ch: fetch_file(day, *ch), jobs))
    return dict(zip(jobs, results))


# ---- convert --------------------------------------------------------------------------

def to_fields(files: dict) -> tuple[dict, dict]:
    """One day's GFS files -> ({map id: (ny, nx)}, {detail id: (ny, nx)})."""
    def stack(name, hours):
        return np.stack([files[(c, h)][name] for c in (0, 6, 12, 18) for h in hours])

    apcp = np.maximum(np.nan_to_num(stack("apcp", [6])), 0)      # mm in each 6-hour period
    precip = apcp.sum(axis=0)
    with np.errstate(divide="ignore", invalid="ignore"):
        snow = np.where(precip >= 0.1, (apcp * np.nan_to_num(stack("csnow", [6]))).sum(axis=0) / precip, 0.0)
        frz = np.where(precip >= 0.1, (apcp * np.nan_to_num(stack("cfrzr", [6]))).sum(axis=0) / precip, 0.0)
    map_vals = {"prmsl": stack("prmsl", [0, 3]).mean(axis=0) / 100, "t2m": stack("t2m", [0, 3]).mean(axis=0) - 273.15}
    detail_vals = {
        "tmax": stack("tmax", [6]).max(axis=0) - 273.15, "tmin": stack("tmin", [6]).min(axis=0) - 273.15,
        "precip": precip, "snow_frac": np.clip(snow, 0, 1), "frz_frac": np.clip(frz, 0, 1),
        "cloud": np.clip(stack("tcdc", [6]).mean(axis=0), 0, 100),
        "u10": stack("u10", [0, 3]).mean(axis=0), "v10": stack("v10", [0, 3]).mean(axis=0),
        "snow_depth": np.clip(np.nan_to_num(stack("snod", [0]).mean(axis=0)) * 100, 0, 3000),   # m -> cm
    }
    for name, vals in {**map_vals, **detail_vals}.items():
        if vals.shape != (LAT.size, LON.size) or np.isnan(vals).any():
            raise ValueError(f"{name}: bad shape or missing values")
    return map_vals, detail_vals


def write_day(vals: dict, fields: list[dict], kind: str, d: str) -> int:
    folder = bd.OUT / SOURCE / kind / d[:4]
    folder.mkdir(parents=True, exist_ok=True)
    arrays = [bd.quantize(vals[f["id"]], f["scale"], f["offset"]) for f in fields]
    blob = gzip.compress(bd.shuffle(np.stack(arrays)), compresslevel=9, mtime=0)
    (folder / f"{d}.bin.gz").write_bytes(blob)
    # read it back the way the site does; every value must be within half a storage step
    raw = bd.unshuffle(gzip.decompress(blob)).reshape(len(fields), -1)
    for f, block in zip(fields, raw):
        err = np.max(np.abs(block.astype("float64") * f["scale"] + f["offset"] - vals[f["id"]].ravel()))
        if (block == bd.NODATA).any() or err > f["scale"] / 2 + 1e-6:
            raise ValueError(f"{d} {kind}/{f['id']}: round-trip error {err}")
    return len(blob)


# ---- upload ---------------------------------------------------------------------------

def rclone(*args: str) -> None:
    if not shutil.which("rclone"):
        raise RuntimeError("rclone is not installed (brew install rclone)")
    subprocess.run(["rclone", *args], check=True)


def publish(dates: list[str], upload: bool, remote: str, keep: bool) -> None:
    """Upload a batch of built days, then record them and update the manifest."""
    if not dates:
        return
    if upload:
        for kind in ("days", "detail"):
            for year in sorted({d[:4] for d in dates}):
                include = [a for d in dates if d[:4] == year for a in ("--include", f"{d}.bin.gz")]
                rclone("copy", str(bd.OUT / SOURCE / kind / year), f"{remote}/{SOURCE}/{kind}/{year}", *include,
                       "--transfers", "16", "--s3-no-check-bucket",
                       "--header-upload", f"Cache-Control: {IMMUTABLE}",
                       "--header-upload", "Content-Type: application/octet-stream")
    done = mark_done(dates)
    bd.update_source(SOURCE, SOURCE_META, MAP_FIELDS, DETAIL_FIELDS, LAT, LON, ranges=bd.ranges_from_dates(done))
    if upload:
        with bd.manifest_lock():
            rclone("copyto", str(bd.MANIFEST), f"{remote}/manifest.json", "--s3-no-check-bucket",
                   "--header-upload", "Cache-Control: public, max-age=300",
                   "--header-upload", "Content-Type: application/json")
        if not keep:
            for kind in ("days", "detail"):
                for d in dates:
                    (bd.OUT / SOURCE / kind / d[:4] / f"{d}.bin.gz").unlink(missing_ok=True)
    log(f"{dates[0]}..{dates[-1]}: {len(dates)} days" + (" uploaded" if upload else " built"))


# ---- run ------------------------------------------------------------------------------

def run(start: date, end: date, upload: bool, remote: str, keep: bool) -> None:
    done = set(load_state()["days"])
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    days = [d for d in days if d.isoformat() not in done]
    log(f"GFS {start}..{end}: {len(days)} days to do, upload={'on' if upload else 'off'}")
    batch, skipped, t0 = [], [], time.time()
    for n, day in enumerate(days, 1):
        if STOP.exists():
            STOP.unlink()
            log("stop file found; stopping cleanly")
            break
        d = day.isoformat()
        try:
            map_vals, detail_vals = to_fields(fetch_day(day))
        except NotReady as e:
            skipped.append(d)
            log(f"{d}: not published yet ({str(e).rsplit('/', 1)[-1]}); skipped")
            continue
        write_day(map_vals, MAP_FIELDS, "days", d)
        write_day(detail_vals, DETAIL_FIELDS, "detail", d)
        batch.append(d)
        if len(batch) >= UPLOAD_EVERY:
            publish(batch, upload, remote, keep)
            batch = []
            left = (len(days) - n) * (time.time() - t0) / n
            log(f"{n}/{len(days)} days done; about {left / 60:.0f} min left at this pace")
    publish(batch, upload, remote, keep)
    log(f"GFS run finished" + (f"; skipped {len(skipped)}: {', '.join(skipped[:10])}" if skipped else ""))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("start", nargs="?", help=f"first day, YYYY-MM-DD (default {FIRST_DAY})")
    ap.add_argument("end", nargs="?", help="last day (default: yesterday, UTC)")
    ap.add_argument("--recent", type=int, metavar="N", help="only the last N days (for the daily job)")
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--remote", default="r2:weatherthen-data")
    ap.add_argument("--keep", action="store_true", help="keep built files locally after uploading")
    a = ap.parse_args()
    yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
    end = date.fromisoformat(a.end) if a.end else yesterday
    start = (yesterday - timedelta(days=a.recent - 1)) if a.recent else date.fromisoformat(a.start or FIRST_DAY.isoformat())
    try:
        run(start, min(end, yesterday), a.upload, a.remote, a.keep)
    except KeyboardInterrupt:
        log("interrupted; re-run to resume")
    except Exception as e:  # noqa: BLE001
        log(f"error: {str(e)[:500]}; stopped (re-run to resume)")
        raise
