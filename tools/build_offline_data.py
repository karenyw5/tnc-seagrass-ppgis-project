"""Build the static map data used by the offline web app in docs/.

Run once (needs internet only for the coastline download):
    python tools/build_offline_data.py

Writes:
    docs/data/hexes.geojson      demo hex grid (same hex IDs as streamlit_app/app.py)
    docs/data/coastline.geojson  simplified OSM land polygons around the focus areas
"""

import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, box, mapping
from shapely.ops import linemerge, transform, unary_union

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"

# Keep in sync with streamlit_app/app.py and docs/js/config.js.
FOCUS_AREAS = {
    "Sanur": {"center": [-8.707, 115.263]},
    "Padang Bai": {"center": [-8.531, 115.509]},
    "Nusa Lembongan": {"center": [-8.680, 115.455]},
}
HEX_RADIUS_M = 500
FOCUS_RADIUS_M = 4000
TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32750", always_xy=True).transform
TO_WGS84 = Transformer.from_crs("EPSG:32750", "EPSG:4326", always_xy=True).transform

# Whole of Bali plus Nusa Penida/Lembongan, so island coastlines close into rings.
BALI_BBOX = (-8.95, 114.40, -8.03, 115.75)  # south, west, north, east
# The area actually shipped to the app: the focus areas plus a margin.
CLIP_BOX = box(115.15, -8.82, 115.62, -8.44)  # (west, south, east, north)
SIMPLIFY_DEG = 0.00015  # roughly 15 m
OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)


def hexagon(cx, cy, radius):
    return Polygon([
        (cx + radius * math.cos(math.radians(60 * i)),
         cy + radius * math.sin(math.radians(60 * i)))
        for i in range(6)
    ])


def create_hex_grid():
    """Same algorithm as create_hex_grid() in streamlit_app/app.py."""
    features = []
    for focus_area, info in FOCUS_AREAS.items():
        lat, lon = info["center"]
        center = transform(TO_UTM, Point(lon, lat))
        focus_zone = center.buffer(FOCUS_RADIUS_M)
        minx, miny, maxx, maxy = focus_zone.bounds
        sx, sy = 1.5 * HEX_RADIUS_M, math.sqrt(3) * HEX_RADIUS_M
        column, x, count = 0, minx - HEX_RADIUS_M, 1
        while x <= maxx + HEX_RADIUS_M:
            y = miny - HEX_RADIUS_M + (sy / 2 if column % 2 else 0)
            while y <= maxy + HEX_RADIUS_M:
                cell = hexagon(x, y, HEX_RADIUS_M)
                if focus_zone.contains(cell.centroid):
                    features.append({
                        "type": "Feature",
                        "properties": {
                            "hex_id": f"{focus_area.replace(' ', '_')}_{count:03d}",
                            "focus_area": focus_area,
                        },
                        "geometry": mapping(transform(TO_WGS84, cell)),
                    })
                    count += 1
                y += sy
            column += 1
            x += sx
    return {"type": "FeatureCollection", "features": features}


def fetch_coastline_ways():
    south, west, north, east = BALI_BBOX
    query = (
        f"[out:json][timeout:120];"
        f'way["natural"="coastline"]({south},{west},{north},{east});'
        f"out geom;"
    )
    body = urllib.parse.urlencode({"data": query}).encode()
    for url in OVERPASS_URLS:
        request = urllib.request.Request(
            url, data=body,
            headers={"User-Agent": "tnc-seagrass-ppgis offline data build"},
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                elements = json.load(response)["elements"]
            break
        except OSError as exc:  # HTTPError and URLError are both OSErrors
            print(f"Overpass server {url} failed ({exc}); trying the next one.",
                  file=sys.stderr)
    else:
        sys.exit("All Overpass servers failed. Try again later.")
    return [
        LineString([(node["lon"], node["lat"]) for node in way["geometry"]])
        for way in elements
        if way.get("type") == "way" and len(way.get("geometry", [])) >= 2
    ]


def build_land(ways):
    """Merge coastline ways into closed rings; each closed ring is an island/land area."""
    merged = linemerge(ways)
    lines = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
    rings = [Polygon(line.coords) for line in lines if line.is_ring]
    open_count = sum(1 for line in lines if not line.is_ring)
    if open_count:
        print(f"Warning: {open_count} coastline pieces did not close and were skipped.",
              file=sys.stderr)
    # OSM coastlines run with land on the left, i.e. counter-clockwise around islands.
    land = unary_union([ring for ring in rings if ring.exterior.is_ccw and ring.is_valid])
    return land.intersection(CLIP_BOX).simplify(SIMPLIFY_DEG, preserve_topology=True)


def round_coords(geometry, digits=5):
    def _round(value):
        if isinstance(value, (list, tuple)):
            return [_round(item) for item in value]
        return round(value, digits)
    geometry = dict(geometry)
    geometry["coordinates"] = _round(geometry["coordinates"])
    return geometry


def write_json(path, data):
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.0f} KB)")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    hexes = create_hex_grid()
    write_json(DATA_DIR / "hexes.geojson", hexes)
    print(f"  {len(hexes['features'])} hexagons")

    land = build_land(fetch_coastline_ways())
    write_json(DATA_DIR / "coastline.geojson", {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"source": "© OpenStreetMap contributors (ODbL)"},
            "geometry": round_coords(mapping(land)),
        }],
    })


if __name__ == "__main__":
    main()
