"""Turn one year of 20CRv3 daily netCDF files into small per-day grid files.

Usage:  .venv/bin/python pipeline/build_days.py 1888

Reads   data/raw/<year>/*.nc (see pipeline/fetch.py)
Writes  data/out/20cr/days/<year>/<YYYY-MM-DD>.bin.gz     map fields, one file per day
        data/out/20cr/detail/<year>/<YYYY-MM-DD>.bin.gz   conditions (rain, snow, cloud,
                                                           wind, highs/lows) for the place
                                                           report and rain/snow layer
        data/out/manifest.json                             grid, sources, date ranges

Manifest v4: {grid, nodata, sources: {<id>: {name, short, url, license, citation,
spread, preliminary, map: {path, fields}, detail: {path, fields}, ranges: [{start,
end}]}}, priority: [<id>...]}. Other sources (ERA5, GFS) add themselves the same way.

Day file format (the front end decodes this; keep the two in sync):
  gzip of byte-shuffled int16 values. Unshuffled, the payload is one block
  per field in the order listed in manifest["fields"]; each block is ny rows x
  nx columns, row 0 is the northernmost latitude, column 0 the westernmost
  longitude (-180). Real value = stored * scale + offset; -32768 = no data.
  Detail files use the same format with manifest["detail"]["fields"].
  Byte shuffle: for N int16 values, the file holds the N high bytes first,
  then the N low bytes. Value i = int16((hi[i] << 8) | lo[i]). Shuffling first
  makes gzip about 15% smaller.
"""

from __future__ import annotations

import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parent.parent
SOURCE = "20cr"
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "out"  # served at /data/ by serve.py locally; uploaded to R2 for the live site
NODATA = -32768

# id, source file, netCDF variable, unit conversion, display unit, scale, offset
FIELDS = [
    dict(id="prmsl", file="prmsl.nc", var="prmsl",
         convert=lambda pa: pa / 100.0, units="hPa", scale=0.1, offset=1000.0,
         name="Sea-level pressure (ensemble mean)"),
    dict(id="t2m", file="air.2m.nc", var="air",
         convert=lambda k: k - 273.15, units="°C", scale=0.1, offset=0.0,
         name="2 m air temperature (ensemble mean)"),
    dict(id="prmsl_spread", file="prmsl.spread.nc", var="prmsl",
         convert=lambda pa: pa / 100.0, units="hPa", scale=0.1, offset=0.0,
         name="Sea-level pressure (ensemble spread)"),
    dict(id="t2m_spread", file="air.2m.spread.nc", var="air",
         convert=lambda k: k, units="°C", scale=0.1, offset=0.0,  # a spread in K equals one in °C
         name="2 m air temperature (ensemble spread)"),
]

# Detail fields. 20CR daily means of 3-hourly values; precipitation is the mean
# 3-hour accumulation, so the daily total is 8 times it. Categorical snow and
# freezing rain become the fraction of the day's 3-hour steps with that type.
DETAIL_FIELDS = [
    dict(id="tmax", file="tmax.2m.nc", var="tmax",
         convert=lambda k: k - 273.15, units="°C", scale=0.2, offset=0.0,
         name="Daily maximum 2 m temperature (of 3-hourly values)"),
    dict(id="tmin", file="tmin.2m.nc", var="tmin",
         convert=lambda k: k - 273.15, units="°C", scale=0.2, offset=0.0,
         name="Daily minimum 2 m temperature (of 3-hourly values)"),
    dict(id="precip", file="apcp.nc", var="apcp",
         convert=lambda kg: kg * 8, units="mm", scale=0.1, offset=0.0,
         name="Total precipitation for the day"),
    dict(id="snow_frac", file="csnow.nc", var="csnow",
         convert=lambda f: f, units="fraction", scale=0.01, offset=0.0,
         name="Share of the day with snow falling (categorical)"),
    dict(id="frz_frac", file="cfrzr.nc", var="cfrzr",
         convert=lambda f: f, units="fraction", scale=0.01, offset=0.0,
         name="Share of the day with freezing rain (categorical)"),
    dict(id="cloud", file="tcdc.nc", var="tcdc",
         convert=lambda p: p, units="%", scale=5.0, offset=0.0,
         name="Total cloud cover (daily mean)"),
    dict(id="u10", file="uwnd.10m.nc", var="uwnd",
         convert=lambda v: v, units="m/s", scale=0.5, offset=0.0,
         name="10 m eastward wind (daily mean)"),
    dict(id="v10", file="vwnd.10m.nc", var="vwnd",
         convert=lambda v: v, units="m/s", scale=0.5, offset=0.0,
         name="10 m northward wind (daily mean)"),
    dict(id="snow_depth", file="snod.nc", var="snod",
         convert=lambda m: m * 100, units="cm", scale=0.5, offset=0.0,
         name="Snow depth on the ground (land only)"),
]

SOURCE_META = {
    "name": "NOAA-CIRES-DOE 20th Century Reanalysis version 3 (daily means)",
    "short": "20CRv3",
    "provider": "NOAA Physical Sciences Laboratory, Boulder, Colorado, USA",
    "url": "https://psl.noaa.gov/data/gridded/data.20thC_ReanV3.html",
    "license": "CC BY 4.0",
    "spread": True,          # has ensemble spread (uncertainty) fields
    "preliminary": False,
    "citation": "Slivinski, L. C., et al. (2019). Towards a more reliable historical "
                "reanalysis: Improvements for version 3 of the Twentieth Century "
                "Reanalysis system. Q. J. R. Meteorol. Soc., 145, 2876-2908.",
}


def to_display_grid(da: xr.DataArray) -> xr.DataArray:
    """North-up rows and longitudes from -180 to 179."""
    da = da.sortby("lat", ascending=False)
    da = da.assign_coords(lon=((da.lon + 180) % 360) - 180).sortby("lon")
    return da


def quantize(values: np.ndarray, scale: float, offset: float) -> np.ndarray:
    q = np.round((values - offset) / scale)
    if np.nanmax(np.abs(q)) > 32767:
        raise ValueError(f"values out of int16 range for scale={scale}, offset={offset}")
    q = np.where(np.isnan(q), NODATA, q)
    return q.astype("<i2")


def shuffle(values: np.ndarray) -> bytes:
    """All high bytes, then all low bytes (see the format note at the top)."""
    u = values.astype("<i2").ravel().view(np.uint8).reshape(-1, 2)
    return u[:, 1].tobytes() + u[:, 0].tobytes()


def unshuffle(blob: bytes) -> np.ndarray:
    b = np.frombuffer(blob, dtype=np.uint8)
    n = b.size // 2
    return ((b[:n].astype(np.uint16) << 8) | b[n:]).view("<i2")


def build_year(year: int, fields: list[dict], kind: str) -> dict:
    """Write one file per day for `fields` under data/out/20cr/<kind>/<year>/."""
    src = RAW / str(year)
    arrays, lat, lon, times = [], None, None, None
    for f in fields:
        path = src / f["file"]
        if not path.exists():
            sys.exit(f"missing {path} (run pipeline/fetch.sh {year} first)")
        ds = xr.open_dataset(path)
        da = to_display_grid(ds[f["var"]])
        if lat is None:
            lat, lon, times = da.lat.values, da.lon.values, da.time.values
        elif not (np.array_equal(lat, da.lat.values) and np.array_equal(lon, da.lon.values)
                  and np.array_equal(times, da.time.values)):
            sys.exit(f"{f['file']} grid or dates differ from {fields[0]['file']}")
        arrays.append(quantize(f["convert"](da.values.astype("float64")), f["scale"], f["offset"]))

    day_dir = OUT / SOURCE / kind / str(year)
    day_dir.mkdir(parents=True, exist_ok=True)
    dates = [str(t)[:10] for t in times]
    total = 0
    for i, d in enumerate(dates):
        blob = gzip.compress(shuffle(np.stack([a[i] for a in arrays])), compresslevel=9, mtime=0)
        (day_dir / f"{d}.bin.gz").write_bytes(blob)
        total += len(blob)

    print(f"{year} {kind}: {len(dates)} days, {total / 1e6:.1f} MB "
          f"({total / len(dates) / 1e3:.0f} KB/day)")
    return dict(lat=lat, lon=lon, dates=dates, bytes=total)


def field_meta(fields: list[dict]) -> list[dict]:
    return [dict(id=f["id"], name=f["name"], units=f["units"], scale=f["scale"], offset=f["offset"])
            for f in fields]


def merge_ranges(ranges: list[dict], start: str, end: str) -> list[dict]:
    """Add [start, end] and merge ranges that overlap or touch."""
    one_day = np.timedelta64(1, "D")
    out = []
    for r in sorted(ranges + [dict(start=start, end=end)], key=lambda r: r["start"]):
        if out and np.datetime64(r["start"]) <= np.datetime64(out[-1]["end"]) + one_day:
            out[-1]["end"] = max(out[-1]["end"], r["end"])
        else:
            out.append(dict(r))
    return out


def load_manifest() -> dict:
    path = OUT / "manifest.json"
    m = json.loads(path.read_text()) if path.exists() else {}
    if m.get("version") != 4:  # older layouts are rebuilt, not migrated
        m = {}
    return m


def write_manifest(year: int, info: dict) -> None:
    path = OUT / "manifest.json"
    manifest = load_manifest()
    lat, lon = info["lat"], info["lon"]
    manifest["version"] = 4
    manifest["format"] = ("gzip of byte-shuffled int16 (all high bytes, then all low bytes); "
                          "field blocks, row 0 = north, col 0 = west; value = stored*scale+offset")
    manifest["nodata"] = NODATA
    manifest["grid"] = dict(nx=len(lon), ny=len(lat),
                            lon0=float(lon[0]), lat0=float(lat[0]),
                            dlon=float(lon[1] - lon[0]), dlat=float(lat[1] - lat[0]))
    sources = manifest.setdefault("sources", {})
    src = sources.get(SOURCE, {})
    src.update(SOURCE_META)
    src["map"] = dict(path=f"{SOURCE}/days/{{year}}/{{date}}.bin.gz", fields=field_meta(FIELDS))
    src["detail"] = dict(path=f"{SOURCE}/detail/{{year}}/{{date}}.bin.gz", fields=field_meta(DETAIL_FIELDS))
    src["ranges"] = merge_ranges(src.get("ranges", []), info["dates"][0], info["dates"][-1])
    sources[SOURCE] = src
    # When sources overlap, the first listed wins (newest data first).
    manifest["priority"] = [k for k in ("gfs", "era5", "20cr") if k in sources]
    manifest["built"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {path.relative_to(ROOT)}")


def grid_file(manifest: dict, source: str, kind: str, date: str) -> Path:
    """Local path of a built day file (kind: 'map' or 'detail')."""
    tmpl = manifest["sources"][source][kind]["path"]
    return OUT / tmpl.format(year=date[:4], date=date)


def decode_file(manifest: dict, source: str, kind: str, date: str) -> dict[str, np.ndarray]:
    """Decode a built day file the way the site does: {field id: 2-D float array}."""
    g = manifest["grid"]
    fields = manifest["sources"][source][kind]["fields"]
    vals = unshuffle(gzip.decompress(grid_file(manifest, source, kind, date).read_bytes()))
    vals = vals.reshape(len(fields), g["ny"], g["nx"])
    out = {}
    for f, block in zip(fields, vals):
        v = block.astype("float64") * f["scale"] + f["offset"]
        v[block == manifest["nodata"]] = np.nan
        out[f["id"]] = v
    return out


def verify_year(year: int, dates: list[str]) -> None:
    """Round-trip check: decode the first, middle and last day of each kind and compare
    with the source netCDF. Every value must be within half a storage step."""
    manifest = load_manifest()
    for kind, fields in (("map", FIELDS), ("detail", DETAIL_FIELDS)):
        sources = {f["id"]: to_display_grid(xr.open_dataset(RAW / str(year) / f["file"])[f["var"]]) for f in fields}
        for date in (dates[0], dates[len(dates) // 2], dates[-1]):
            decoded = decode_file(manifest, SOURCE, kind, date)
            for f in fields:
                ref = f["convert"](sources[f["id"]].sel(time=date).values.astype("float64"))
                ok = np.isnan(ref) == np.isnan(decoded[f["id"]])
                err = np.nanmax(np.abs(decoded[f["id"]] - ref)) if np.any(~np.isnan(ref)) else 0.0
                if not ok.all() or err > f["scale"] / 2 + 1e-6:
                    raise ValueError(f"{date} {kind}/{f['id']}: round-trip error {err} > {f['scale'] / 2}")
    print(f"{year}: verified")


def build(year: int) -> dict:
    info = build_year(year, FIELDS, "days")
    detail = build_year(year, DETAIL_FIELDS, "detail")
    if detail["dates"] != info["dates"]:
        raise ValueError("detail dates differ from map dates")
    write_manifest(year, info)
    verify_year(year, info["dates"])
    return dict(dates=info["dates"], bytes=info["bytes"] + detail["bytes"])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    build(int(sys.argv[1]))
