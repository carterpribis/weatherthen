"""Compare a year of built detail files with a real weather station.

Usage:  .venv/bin/python pipeline/validate_station.py 1888 USW00094728 40.779 -73.969

Downloads the station's GHCN-Daily records for the year from NOAA NCEI, decodes
the detail file for every day (as the site does), samples the grid at the
station, and reports how well they agree: highs and lows, precipitation,
wet days, snow days, and the Great Blizzard of March 1888 day by day.
"""

from __future__ import annotations

import gzip
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "out"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_days import SOURCE, decode_file  # noqa: E402


def station_year(station: str, year: int) -> dict[str, dict]:
    url = ("https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries"
           f"&stations={station}&startDate={year}-01-01&endDate={year}-12-31"
           "&dataTypes=TMAX,TMIN,PRCP,SNOW&units=metric&format=json")
    with urllib.request.urlopen(url, timeout=60) as r:
        rows = json.load(r)
    return {row["DATE"]: row for row in rows}


def sample(manifest: dict, date: str, lat: float, lon: float) -> dict[str, float]:
    g = manifest["grid"]
    grids = decode_file(manifest, SOURCE, "detail", date)
    u = ((lon - g["lon0"]) / g["dlon"]) % g["nx"]
    v = (lat - g["lat0"]) / g["dlat"]
    i0, j0 = int(u), int(v)
    fx, fy = u - i0, v - j0
    i1, j1 = (i0 + 1) % g["nx"], min(j0 + 1, g["ny"] - 1)
    out = {}
    for fid, b in grids.items():
        out[fid] = (b[j0, i0] * (1 - fx) + b[j0, i1] * fx) * (1 - fy) + (b[j1, i0] * (1 - fx) + b[j1, i1] * fx) * fy
    return out


def main(year: int, station: str, lat: float, lon: float) -> None:
    manifest = json.loads((DATA / "manifest.json").read_text())
    obs = station_year(station, year)
    dates = [str(d)[:10] for d in np.arange(np.datetime64(f"{year}-01-01"), np.datetime64(f"{year + 1}-01-01"))]
    model = {d: sample(manifest, d, lat, lon) for d in dates}

    def pairs(okey, mkey, scale=1.0):
        a = [(float(obs[d][okey]) * scale, model[d][mkey]) for d in dates if d in obs and obs[d].get(okey) not in (None, "")]
        return np.array(a)

    print(f"{station} {year}: {len(obs)} days of station records")
    for okey, mkey in [("TMAX", "tmax"), ("TMIN", "tmin")]:
        p = pairs(okey, mkey)
        r = np.corrcoef(p[:, 0], p[:, 1])[0, 1]
        print(f"  {okey}: n={len(p)}  correlation {r:.2f}  mean bias {np.mean(p[:, 1] - p[:, 0]):+.1f} °C"
              f"  typical error {np.sqrt(np.mean((p[:, 1] - p[:, 0]) ** 2)):.1f} °C")
    p = pairs("PRCP", "precip")
    wet_o, wet_m = p[:, 0] >= 1, p[:, 1] >= 1
    print(f"  PRCP: n={len(p)}  correlation {np.corrcoef(p[:, 0], p[:, 1])[0, 1]:.2f}"
          f"  station total {p[:, 0].sum():.0f} mm, model {p[:, 1].sum():.0f} mm")
    print(f"        wet days (>=1 mm): station {wet_o.sum()}, model {wet_m.sum()}, "
          f"both {np.sum(wet_o & wet_m)} ({np.sum(wet_o & wet_m) / max(wet_o.sum(), 1):.0%} of station wet days caught)")
    s = np.array([(float(obs[d]["SNOW"]), model[d]["snow_frac"], model[d]["precip"])
                  for d in dates if d in obs and obs[d].get("SNOW") not in (None, "")])
    snow_o = s[:, 0] >= 10           # >= 1 cm of new snow at the station
    snow_m = (s[:, 1] >= 0.25) & (s[:, 2] >= 1)
    print(f"  SNOW days (>=1 cm): station {snow_o.sum()}, model snow days {snow_m.sum()}, both {np.sum(snow_o & snow_m)}")

    print("  Great Blizzard check:")
    for d in ["1888-03-11", "1888-03-12", "1888-03-13", "1888-03-14"]:
        m, o = model[d], obs.get(d, {})
        print(f"    {d}: model precip {m['precip']:.1f} mm, snow {m['snow_frac']:.0%} of day, "
              f"high/low {m['tmax']:.1f}/{m['tmin']:.1f} °C, cloud {m['cloud']:.0f}%, "
              f"wind {np.hypot(m['u10'], m['v10']):.1f} m/s  |  station PRCP {o.get('PRCP')} SNOW {o.get('SNOW')} TMAX {o.get('TMAX')} TMIN {o.get('TMIN')}")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    main(int(sys.argv[1]), sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))
