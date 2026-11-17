"""Download one year of 20CRv3 daily files from NOAA PSL, a few files at a time.

Usage:  .venv/bin/python pipeline/fetch.py 1888 [--jobs 4]

Files land in data/raw/<year>/. Finished files are skipped; partial downloads
resume. NOAA serves 1806-1980 from "...SI" folders and 1981-2015 from "...MO"
folders (same files, different stream). PSL limits each connection to about
0.8 MB/s, so a few parallel downloads help; keep it polite (4-6 at most).
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
BASE = "https://downloads.psl.noaa.gov/Datasets/20thC_ReanV3"
FIRST_YEAR, LAST_YEAR = 1806, 2015

# local name -> (folder group, remote file name pattern); "{s}" is SI or MO.
FILES = {
    # map: ensemble mean and spread
    "prmsl.nc":         "Dailies/misc{s}/prmsl.{y}.nc",
    "air.2m.nc":        "Dailies/2m{s}/air.2m.{y}.nc",
    "prmsl.spread.nc":  "spreads/Dailies/misc{s}/prmsl.{y}.nc",
    "air.2m.spread.nc": "spreads/Dailies/2m{s}/air.2m.{y}.nc",
    # detail: conditions for the place report and the rain/snow layer
    "tmax.2m.nc":       "Dailies/2m{s}/tmax.2m.{y}.nc",
    "tmin.2m.nc":       "Dailies/2m{s}/tmin.2m.{y}.nc",
    "apcp.nc":          "Dailies/accums{s}/apcp.{y}.nc",
    "csnow.nc":         "Dailies/sfc{s}/csnow.{y}.nc",
    "cfrzr.nc":         "Dailies/sfc{s}/cfrzr.{y}.nc",
    "tcdc.nc":          "Dailies/misc{s}/tcdc.eatm.{y}.nc",
    "uwnd.10m.nc":      "Dailies/10m{s}/uwnd.10m.{y}.nc",
    "vwnd.10m.nc":      "Dailies/10m{s}/vwnd.10m.{y}.nc",
    "snod.nc":          "Dailies/accums{s}/snod.{y}.nc",
}


def url_for(name: str, year: int) -> str:
    stream = "SI" if year <= 1980 else "MO"
    return f"{BASE}/{FILES[name].format(s=stream, y=year)}"


def download(url: str, dest: Path, retries: int = 4) -> int:
    """Download url to dest (resuming dest.part). Returns bytes on disk."""
    if dest.exists():
        return dest.stat().st_size
    part = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        have = part.stat().st_size if part.exists() else 0
        req = urllib.request.Request(url, headers={"User-Agent": "weatherthen-pipeline"})
        if have:
            req.add_header("Range", f"bytes={have}-")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                if have and r.status != 206:  # server ignored the range: start over
                    have = 0
                with open(part, "ab" if have else "wb") as f:
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
            part.rename(dest)
            return dest.stat().st_size
        except urllib.error.HTTPError as e:
            if e.code == 416 and have:  # already complete
                part.rename(dest)
                return dest.stat().st_size
            if e.code == 404:
                raise
            err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        time.sleep(5 * attempt)
    raise RuntimeError(f"{url}: {err}")


def fetch_year(year: int, jobs: int = 4, log=print) -> Path:
    if not FIRST_YEAR <= year <= LAST_YEAR:
        raise ValueError(f"20CRv3 covers {FIRST_YEAR}-{LAST_YEAR}")
    out = RAW / str(year)
    out.mkdir(parents=True, exist_ok=True)
    start, total = time.time(), 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(download, url_for(n, year), out / n): n for n in FILES}
        for fut in as_completed(futures):
            total += fut.result()  # re-raises download errors
    secs = time.time() - start
    log(f"{year}: fetched {total / 1e6:.0f} MB in {secs:.0f}s ({total / 1e6 / max(secs, 1):.1f} MB/s)")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("year", type=int)
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    try:
        fetch_year(a.year, a.jobs)
    except Exception as e:  # noqa: BLE001
        sys.exit(str(e))
