#!/usr/bin/env python3
"""Build data/projects.json from the two CSV files.

Edit the CSVs in a spreadsheet, then run:
    python3 tools/build_data.py

data/projects.csv      one row per project
data/budget_lines.csv  one row per year or funding source, linked by project_id
data/history.csv       optional: what each budget or plan document said, over time
data/routes.geojson    optional: road lines, one feature per project (properties.project_id)
data/wards.geojson     ward boundaries (Municipal Demarcation Board)

Amounts are rands excluding VAT. Leave `adjusted` empty for planned years.
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATUSES = {"complete", "in_progress", "funded", "deferred", "planned"}
LEVELS = {"municipal", "district", "provincial", "national"}
PINS = {"site", "village", "route"}


def num(value, field, where):
    value = (value or "").replace(" ", "").replace(",", "").replace("R", "")
    if value == "":
        return None
    try:
        return float(value) if "." in value else int(value)
    except ValueError:
        sys.exit(f"{where}: '{field}' is not a number: {value!r}")


def split_names(text):
    """'A (Pty) Ltd; B cc' -> ['A (Pty) Ltd', 'B cc']"""
    return [n.strip() for n in (text or "").split(";") if n.strip()]


def parse_sources(text):
    sources = []
    for part in (text or "").split(";"):
        part = part.strip()
        if not part:
            continue
        label, sep, url = part.rpartition("|")
        sources.append({"label": label.strip() if sep else "", "url": url.strip()})
    return sources


def parse_wards(text):
    """'24, 29 to 33' -> {24, 29, 30, 31, 32, 33}. Same rule as parseWards in app.js."""
    out = set()
    for part in re.split(r"[,;]", text or ""):
        m = re.search(r"(\d+)\s*(?:to|-|–)\s*(\d+)", part)
        if m:
            out.update(range(int(m[1]), int(m[2]) + 1))
        else:
            out.update(int(n) for n in re.findall(r"\d+", part))
    return out


def point_in_ring(x, y, ring):
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def ward_at(wards, lat, lon):
    """Ward number whose boundary contains the point, or None."""
    for f in wards["features"]:
        g = f["geometry"]
        for poly in g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]:
            if point_in_ring(lon, lat, poly[0]) and not any(point_in_ring(lon, lat, h) for h in poly[1:]):
                return f["properties"]["ward"]
    return None


def main():
    wards = json.loads((DATA / "wards.geojson").read_text(encoding="utf-8"))
    projects = {}
    with open(DATA / "projects.csv", newline="", encoding="utf-8") as f:
        for i, row in enumerate(csv.DictReader(f), start=2):
            where = f"projects.csv line {i}"
            pid = (row.get("id") or "").strip()
            if not pid:
                sys.exit(f"{where}: id is empty")
            if pid in projects:
                sys.exit(f"{where}: duplicate id {pid!r}")
            status = (row.get("status") or "").strip()
            if status not in STATUSES:
                sys.exit(f"{where}: status must be one of {sorted(STATUSES)}, got {status!r}")
            level = (row.get("level") or "").strip()
            if level not in LEVELS:
                sys.exit(f"{where}: level must be one of {sorted(LEVELS)}, got {level!r}")
            lat = num(row.get("lat"), "lat", where)
            lon = num(row.get("lon"), "lon", where)
            if (lat is None) != (lon is None):
                sys.exit(f"{where}: give both lat and lon, or neither")
            pin = (row.get("pin") or "").strip()
            if pin and pin not in PINS:
                sys.exit(f"{where}: pin must be one of {sorted(PINS)} or empty, got {pin!r}")
            projects[pid] = {
                "id": pid,
                "name": row["name"].strip(),
                "short": (row.get("short") or "").strip(),
                "sector": (row.get("sector") or "Other").strip(),
                "status": status,
                "statusNote": (row.get("status_note") or "").strip(),
                "progress": (row.get("progress") or "").strip(),
                "due": (row.get("due") or "").strip(),
                "dataIssue": (row.get("data_issue") or "").strip(),
                "implementer": (row.get("implementer") or "").strip(),
                "contractor": split_names(row.get("contractor")),
                "consultant": split_names(row.get("consultant")),
                "contractNote": (row.get("contract_note") or "").strip(),
                "level": level,
                "ward": (row.get("ward") or "").strip(),
                "village": (row.get("village") or "").strip(),
                "lat": lat,
                "lon": lon,
                "pin": pin or ("site" if lat is not None else ""),
                "route": None,
                "note": (row.get("note") or "").strip(),
                "sources": parse_sources(row.get("sources")),
                "budget": [],
                "history": [],
                "mapWard": ward_at(wards, lat, lon) if lat is not None else None,
            }
            # Warn (don't stop) when the pin is outside the ward the CSV names.
            mw, listed = projects[pid]["mapWard"], projects[pid]["ward"]
            if mw is not None and listed and mw not in parse_wards(listed):
                print(f"warning: {where}: {pid} is in ward {listed!r} but its pin falls in ward {mw}")

    with open(DATA / "budget_lines.csv", newline="", encoding="utf-8") as f:
        for i, row in enumerate(csv.DictReader(f), start=2):
            where = f"budget_lines.csv line {i}"
            pid = (row.get("project_id") or "").strip()
            if pid not in projects:
                sys.exit(f"{where}: unknown project_id {pid!r}")
            projects[pid]["budget"].append({
                "fy": row["fy"].strip(),
                "original": num(row.get("original"), "original", where) or 0,
                "adjusted": num(row.get("adjusted"), "adjusted", where),
                "label": (row.get("label") or "").strip(),
            })

    routes = DATA / "routes.geojson"
    if routes.exists():
        for i, feat in enumerate(json.loads(routes.read_text(encoding="utf-8"))["features"]):
            where = f"routes.geojson feature {i}"
            pid = (feat.get("properties") or {}).get("project_id")
            if pid not in projects:
                sys.exit(f"{where}: unknown project_id {pid!r}")
            g = feat["geometry"]
            if g["type"] not in ("LineString", "MultiLineString"):
                sys.exit(f"{where}: geometry must be LineString or MultiLineString, got {g['type']}")
            lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
            # [[lat, lon], ...] per line, rounded to about 1 m.
            route = [[[round(y, 5), round(x, 5)] for x, y, *_ in line] for line in lines]
            p = projects[pid]
            p["route"] = (p["route"] or []) + route
            p["routeNote"] = (feat["properties"].get("note") or "").strip()
            if p["lat"] is None:
                # No pin given: put it on the middle of the longest line.
                y, x = max(route, key=len)[len(max(route, key=len)) // 2]
                p["lat"], p["lon"], p["mapWard"] = y, x, ward_at(wards, y, x)
            p["pin"] = "route"

    hist = DATA / "history.csv"
    if hist.exists():
        with open(hist, newline="", encoding="utf-8") as f:
            for i, row in enumerate(csv.DictReader(f), start=2):
                where = f"history.csv line {i}"
                pid = (row.get("project_id") or "").strip()
                if pid not in projects:
                    print(f"warning: {where}: skipping unknown project_id {pid!r}")
                    continue
                projects[pid]["history"].append({
                    "date": (row.get("date") or "").strip(),
                    "document": (row.get("document") or "").strip(),
                    "fy": (row.get("fy") or "").strip(),
                    "amount": num(row.get("amount"), "amount", where),
                    "vat": (row.get("vat") or "").strip(),
                    "progress": (row.get("progress") or "").strip(),
                    "note": (row.get("note") or "").strip(),
                })
        for p in projects.values():
            p["history"].sort(key=lambda h: (h["date"], h["fy"]))

    (DATA / "wards.js").write_text("window.WARDS = " + json.dumps(wards, separators=(",", ":")) + ";\n", encoding="utf-8")

    out = DATA / "projects.json"
    text = json.dumps(list(projects.values()), indent=2, ensure_ascii=False)
    out.write_text(text, encoding="utf-8")
    # Same data as a script, so index.html also works when opened from file://.
    (DATA / "projects.js").write_text(f"window.PROJECTS = {text};\n", encoding="utf-8")
    print(f"Wrote {len(projects)} projects to {out.relative_to(ROOT)} and data/projects.js")


if __name__ == "__main__":
    main()
