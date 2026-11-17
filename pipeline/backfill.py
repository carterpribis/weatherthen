"""Build the 20CRv3 map archive year by year: fetch, build, verify, upload, clean up.

Usage:
  .venv/bin/python pipeline/backfill.py 1836 1840              # build locally, keep output
  .venv/bin/python pipeline/backfill.py 1836 2015 --upload     # full run: upload to R2, keep disk small
  .venv/bin/python pipeline/backfill.py 1836 2015 --upload --uncertainty-only
                      # add the uncertainty files to years built before they existed

Resumable: finished years are recorded in data/backfill-state.json and skipped.
To stop cleanly after the current year: touch data/backfill.stop
Progress is printed and appended to data/backfill.log.

Uploading uses rclone with a remote you configure once (keys stay in rclone's own
config, never in this repo), e.g.:
  rclone config create r2 s3 provider Cloudflare access_key_id=... secret_access_key=... \\
      endpoint=https://<account-id>.r2.cloudflarestorage.com
Override the destination with --remote (default: r2:weatherthen-data).
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_days  # noqa: E402
from fetch import RAW, SPREAD_FILES, fetch_year  # noqa: E402

ROOT = build_days.ROOT
OUT = build_days.OUT
STATE = ROOT / "data" / "backfill-state.json"
STOP = ROOT / "data" / "backfill.stop"
LOG = ROOT / "data" / "backfill.log"
MIN_FREE_GB = 5

IMMUTABLE = "public, max-age=31536000, immutable"
SHORT = "public, max-age=300"


def log(msg: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def load_state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {"done": {}}


def save_state(state: dict) -> None:
    STATE.write_text(json.dumps(state, indent=1, sort_keys=True) + "\n")


def free_gb() -> float:
    return shutil.disk_usage(ROOT).free / 1e9


def rclone(*args: str) -> None:
    if not shutil.which("rclone"):
        raise RuntimeError("rclone is not installed (brew install rclone)")
    subprocess.run(["rclone", *args], check=True)


KINDS = ("days", "detail", "uncertainty")


def upload_year(year: int, remote: str, kinds=KINDS) -> None:
    for kind in kinds:
        src = OUT / build_days.SOURCE / kind / str(year)
        rclone("copy", str(src), f"{remote}/{build_days.SOURCE}/{kind}/{year}",
               "--transfers", "16", "--checkers", "16", "--s3-no-check-bucket",
               "--header-upload", f"Cache-Control: {IMMUTABLE}",
               "--header-upload", "Content-Type: application/octet-stream")
    upload_manifest(remote)


def upload_manifest(remote: str) -> None:
    rclone("copyto", str(OUT / "manifest.json"), f"{remote}/manifest.json", "--s3-no-check-bucket",
           "--header-upload", f"Cache-Control: {SHORT}",
           "--header-upload", "Content-Type: application/json")


def run(first: int, last: int, upload: bool, remote: str, keep_raw: bool, jobs: int) -> None:
    state = load_state()
    todo = [y for y in range(first, last + 1) if str(y) not in state["done"]]
    log(f"backfill {first}-{last}: {len(todo)} years to do, upload={'on' if upload else 'off'}")
    started = time.time()
    for n, year in enumerate(todo, 1):
        if STOP.exists():
            STOP.unlink()
            log("stop file found; stopping cleanly")
            return
        if free_gb() < MIN_FREE_GB:
            log(f"only {free_gb():.1f} GB free; stopping")
            return
        t0 = time.time()
        fetch_year(year, jobs=jobs, log=log)
        result = build_days.build(year)
        if upload:
            upload_year(year, remote)
            for kind in KINDS:  # uploaded: free the disk
                shutil.rmtree(OUT / build_days.SOURCE / kind / str(year), ignore_errors=True)
        if not keep_raw:
            shutil.rmtree(RAW / str(year), ignore_errors=True)
        state["done"][str(year)] = dict(days=len(result["dates"]), mb=round(result["bytes"] / 1e6, 1),
                                        uploaded=upload, uncertainty=True,
                                        at=datetime.now().isoformat(timespec="seconds"))
        save_state(state)
        per_year = (time.time() - started) / n
        left = (len(todo) - n) * per_year
        log(f"{year}: done in {time.time() - t0:.0f}s; {len(todo) - n} years left, about {left / 3600:.1f} h")
    log("backfill finished")


def run_uncertainty(first: int, last: int, upload: bool, remote: str, keep_raw: bool, jobs: int) -> None:
    """Fetch and build only the uncertainty files for years already done without them."""
    state = load_state()
    todo = [y for y in range(first, last + 1)
            if str(y) in state["done"] and not state["done"][str(y)].get("uncertainty")]
    log(f"uncertainty {first}-{last}: {len(todo)} finished years need it")
    for year in todo:
        if STOP.exists():
            STOP.unlink()
            log("stop file found; stopping cleanly")
            return
        t0 = time.time()
        fetch_year(year, jobs=jobs, log=log, only=SPREAD_FILES)
        build_days.build_uncertainty(year)
        if upload:
            upload_year(year, remote, kinds=("uncertainty",))
            shutil.rmtree(OUT / build_days.SOURCE / "uncertainty" / str(year), ignore_errors=True)
        if not keep_raw:
            for f in SPREAD_FILES:
                (RAW / str(year) / f).unlink(missing_ok=True)
        state = load_state()
        state["done"][str(year)]["uncertainty"] = True
        save_state(state)
        log(f"{year}: uncertainty added in {time.time() - t0:.0f}s")
    log("uncertainty pass finished")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("first", type=int)
    ap.add_argument("last", type=int)
    ap.add_argument("--upload", action="store_true", help="upload each year to R2, then delete local output")
    ap.add_argument("--remote", default="r2:weatherthen-data")
    ap.add_argument("--keep-raw", action="store_true", help="keep downloaded netCDF files")
    ap.add_argument("--jobs", type=int, default=4, help="parallel downloads (be polite: 4-6)")
    ap.add_argument("--uncertainty-only", action="store_true",
                    help="only add uncertainty files to years already done")
    a = ap.parse_args()
    try:
        if a.uncertainty_only:
            run_uncertainty(a.first, a.last, a.upload, a.remote, a.keep_raw, a.jobs)
        else:
            run(a.first, a.last, a.upload, a.remote, a.keep_raw, a.jobs)
    except KeyboardInterrupt:
        log("interrupted; re-run to resume")
    except Exception as e:  # noqa: BLE001
        log(f"error: {e}; re-run to resume")
        raise
