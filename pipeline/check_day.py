"""Sanity-check built day files against the source netCDF and draw a quick map.

Usage:  .venv/bin/python pipeline/check_day.py 1888-03-12 [more dates...]

For each date it:
  1. decodes data/out/20cr/days/<year>/<date>.bin.gz using only manifest.json
     (the same steps the front end will take),
  2. compares every field with the original netCDF (error must be <= scale/2),
  3. prints the deepest low over eastern North America and the western Atlantic,
  4. saves data/check/<date>.png (temperature colours + isobars every 4 hPa).
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "out"
RAW = ROOT / "data" / "raw"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_days import FIELDS, SOURCE, decode_file, to_display_grid  # noqa: E402

CITIES = {"New York": (-74.0, 40.7), "Boston": (-71.1, 42.4),
          "Washington": (-77.0, 38.9), "Albany": (-73.8, 42.7)}


def decode(manifest: dict, date: str) -> dict[str, np.ndarray]:
    return decode_file(manifest, SOURCE, "map", date)


def check(manifest: dict, date: str) -> None:
    g = manifest["grid"]
    lon = g["lon0"] + g["dlon"] * np.arange(g["nx"])
    lat = g["lat0"] + g["dlat"] * np.arange(g["ny"])
    fields = decode(manifest, date)

    # 1-2: round trip against the source files
    for f, meta in zip(FIELDS, manifest["sources"][SOURCE]["map"]["fields"]):
        src = to_display_grid(xr.open_dataset(RAW / date[:4] / f["file"])[f["var"]]).sel(time=date)
        ref = f["convert"](src.values.astype("float64"))
        err = np.nanmax(np.abs(fields[f["id"]] - ref))
        ok = err <= meta["scale"] / 2 + 1e-9
        print(f"  {f['id']:<13} max error {err:.4f} {meta['units']}  {'ok' if ok else 'FAIL'}")
        if not ok:
            sys.exit(1)

    # 3: deepest low in a box over eastern North America / western Atlantic
    box = (lat >= 30) & (lat <= 55)
    lons = (lon >= -85) & (lon <= -55)
    p = fields["prmsl"][np.ix_(box, lons)]
    i, j = np.unravel_index(np.nanargmin(p), p.shape)
    lo_lat, lo_lon = lat[box][i], lon[lons][j]
    spread = fields["prmsl_spread"][np.ix_(box, lons)][i, j]
    print(f"  deepest low: {p[i, j]:.1f} ± {spread:.1f} hPa at {lo_lat:.0f}°N {abs(lo_lon):.0f}°W")
    ny = fields["t2m"][np.argmin(abs(lat - 40.7)), np.argmin(abs(lon + 74.0))]
    print(f"  2 m temperature near New York: {ny:.1f} °C")

    # 4: quick-look map
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    sl = np.s_[np.argmin(abs(lat - 65)):np.argmin(abs(lat - 15)) + 1,
               np.argmin(abs(lon + 120)):np.argmin(abs(lon + 30)) + 1]
    LON, LAT = np.meshgrid(lon, lat)
    fig, ax = plt.subplots(figsize=(10, 6.5), dpi=110)
    pc = ax.pcolormesh(LON[sl], LAT[sl], fields["t2m"][sl], cmap="RdYlBu_r",
                       vmin=-30, vmax=30, shading="nearest")
    cs = ax.contour(LON[sl], LAT[sl], fields["prmsl"][sl],
                    levels=np.arange(940, 1068, 4), colors="k", linewidths=0.8)
    ax.clabel(cs, fmt="%d", fontsize=7)
    for name, (x, y) in CITIES.items():
        ax.plot(x, y, "k^", ms=4)
        ax.annotate(name, (x, y), xytext=(3, 3), textcoords="offset points", fontsize=7)
    ax.plot(lo_lon, lo_lat, "rx", ms=10, mew=2)
    ax.set_title(f"{date}: 2 m temperature (°C) and sea-level pressure (hPa), 20CRv3 daily mean")
    ax.set_xlabel("longitude"); ax.set_ylabel("latitude"); ax.set_aspect(1.25)
    fig.colorbar(pc, ax=ax, shrink=0.8, label="°C")
    out = ROOT / "data" / "check" / f"{date}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, bbox_inches="tight"); plt.close(fig)
    print(f"  saved {out.relative_to(ROOT)}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    m = json.loads((DATA / "manifest.json").read_text())
    for d in sys.argv[1:]:
        print(d)
        check(m, d)
