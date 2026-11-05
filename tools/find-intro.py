#!/usr/bin/env python3
"""Znajduje początek intra audycji w plikach mp3.

Intro jest tym samym nagraniem w każdym odcinku, więc porównujemy przebieg czasowy
(8 kHz mono, NCC) w oknie pierwszych minut odcinka — tam intro występuje.

Użycie:
  tools/find-intro.py intro.mp3 "~/Music/Ciężko na Sercu" [--scan 180] [--json out.json]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from scipy.signal import fftconvolve

RATE = 8000


def pcm(path: Path, duration: float | None = None) -> np.ndarray:
    command = ["ffmpeg", "-v", "error"]
    if duration is not None:
        command += ["-t", str(duration)]
    command += ["-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(RATE), "-"]
    result = subprocess.run(command, capture_output=True, check=True)
    return np.frombuffer(result.stdout, dtype=np.float32)


def find_intro(path: Path, intro: np.ndarray, scan: float) -> dict:
    audio = pcm(path, scan)
    if audio.size < intro.size:
        return {"file": path.name, "error": "plik krótszy niż intro"}

    correlation = fftconvolve(audio, intro[::-1], mode="valid")
    # Energia okna w O(n): suma narastająca zamiast splotu z wektorem jedynek.
    squares = np.concatenate(([0.0], np.cumsum(audio.astype(np.float64) ** 2)))
    window = squares[intro.size :] - squares[: -intro.size]
    energy = np.sqrt(window) + 1e-9
    ncc = correlation / energy / np.sqrt(float((intro.astype(np.float64) ** 2).sum()))

    best = int(np.argmax(ncc))
    peak = float(ncc[best])
    mask = np.ones_like(ncc, dtype=bool)
    mask[max(0, best - intro.size // 2) : best + intro.size // 2] = False
    runner_up = float(ncc[mask].max()) if mask.any() else 0.0
    return {
        "file": path.name,
        "startSec": round(best / RATE, 2),
        "score": round(peak, 4),
        "margin": round(peak - runner_up, 4),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("intro", type=Path)
    parser.add_argument("audio_dir", type=Path)
    parser.add_argument("--scan", type=float, default=180.0, help="ile sekund od początku przeszukać")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    intro = pcm(args.intro)
    files = sorted(Path(args.audio_dir).expanduser().glob("*.mp3"))
    if args.limit:
        files = files[: args.limit]
    if not files:
        print("Brak plików mp3", file=sys.stderr)
        return 1

    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(find_intro, files, [intro] * len(files), [args.scan] * len(files)))

    for item in results:
        if "error" in item:
            print(f"✗ {item['file']}: {item['error']}")
            continue
        flag = "ok " if item["score"] > 0.6 else "?  "
        print(f"{flag}{item['startSec']:8.2f}s  score {item['score']:.3f}  margin {item['margin']:.3f}  {item['file']}")

    if args.json:
        args.json.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
