#!/usr/bin/env python3
"""Dopisuje intro audycji do data/overrides na podstawie wyniku tools/find-intro.py.

Dla każdego odcinka z opracowaniem tworzy wpis addTracks: „Ciężko na sercu — Intro”
z wykrytym czasem startu. Wpisy są scalane, więc istniejące poprawki zostają.

Użycie:
  tools/apply-intro.py /tmp/intro.json [--min-score 0.15] [--max-start 15]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
ARTIST = "Ciężko na sercu"
TITLE = "Intro"
DURATION = 8.06


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("results", type=Path)
    parser.add_argument("--min-score", type=float, default=0.15)
    parser.add_argument("--max-start", type=float, default=15.0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    catalog = json.loads((DATA / "catalog.json").read_text())
    by_date = {}
    for episode in catalog["episodes"]:
        by_date.setdefault(episode["date"], []).append(episode)

    results = json.loads(args.results.read_text())
    applied = skipped = missing = 0

    for item in results:
        if "error" in item:
            skipped += 1
            continue
        if item["score"] < args.min_score or item["startSec"] > args.max_start:
            skipped += 1
            continue
        date = item["file"][:10]
        candidates = by_date.get(date, [])
        if not candidates:
            missing += 1
            continue
        # Ten sam dzień bywa dwoma plikami (reupload) — bierzemy odcinek z opracowaniem.
        episode = next(
            (candidate for candidate in candidates if (DATA / "episodes" / f"{candidate['id']}.json").exists()),
            candidates[0],
        )
        path = DATA / "overrides" / f"{episode['id']}.json"
        override = json.loads(path.read_text()) if path.exists() else {"version": 1, "tracks": [], "topics": []}
        add_tracks = [entry for entry in override.get("addTracks", []) if not (entry.get("artist") == ARTIST and entry.get("title") == TITLE)]
        add_tracks.append({"artist": ARTIST, "title": TITLE, "start": item["startSec"], "durationSec": DURATION})
        override["addTracks"] = add_tracks
        if not args.dry_run:
            path.write_text(json.dumps(override, ensure_ascii=False, indent=2) + "\n")
        applied += 1

    print(f"dopisane: {applied}, pominięte: {skipped}, bez odcinka w katalogu: {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
