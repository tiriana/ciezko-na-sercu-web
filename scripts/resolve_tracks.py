#!/usr/bin/env python3
"""Rozpoznaje utwory oznaczone `#TODO` po kontekście i potwierdza je chromą.

Shazam nie zna całego polskiego undergroundu, więc część bloków muzyki zostaje bez
utworu. Ten krok robi to, co człowiek: czyta, co prowadzący powiedział przed utworem,
bierze z tego wykonawcę i album, a potem sprawdza kandydatów audio — 30-sekundowe
podglądy z Deezera porównujemy z wycinkiem audycji po chromie. Zapisujemy tylko to,
co potwierdziło się dźwiękiem; resztę wypisujemy jako kandydatów do ręcznej decyzji.

Użycie:
  scripts/resolve_tracks.py --episode <uuid> [--write] [--min-score 0.55]
  scripts/resolve_tracks.py --all [--write] [--retry-misses]

Po nieudanym rozpoznaniu pozycja dostaje `contextMiss` i kolejne przebiegi ją
pomijają; `--retry-misses` każe spróbować jeszcze raz (np. po lepszym transkrypcie).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RATE = 8000
SIZE = 2048
HOP = 256
BANDS = 12
MIN_SCORE = 0.55
PLAYER_SCALE_DEFAULT = 1.0
# Rozpoznanie nie wyszło i kontekst tego nie zmieni — taka pozycja dostaje
# znacznik `contextMiss`, żeby kolejne przebiegi nie traciły na niej czasu.
MISS = object()

# (nazwa, zmienna z kluczem, endpoint, modele) — darmowe limity liczą się per model,
# więc po 429 na jednym modelu ten sam klucz obsłuży zapytanie na następnym.
PROVIDERS = [
    ("groq", "GROQ_API_KEY", "https://api.groq.com/openai/v1/chat/completions",
     ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"]),
    ("google", "GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
     ["gemini-2.5-flash", "gemini-2.5-flash-lite"]),
    ("openrouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1/chat/completions",
     ["openrouter/free"]),
    ("cerebras", "CEREBRAS_API_KEY", "https://api.cerebras.ai/v1/chat/completions",
     ["gpt-oss-120b"]),
    ("mistral", "MISTRAL_API_KEY", "https://api.mistral.ai/v1/chat/completions",
     ["mistral-small-latest"]),
]


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ffmpeg_pcm(source: str, extra: list[str] | None = None) -> np.ndarray:
    command = ["ffmpeg", "-v", "error", *(extra or []), "-i", source, "-f", "s16le", "-ac", "1", "-ar", str(RATE), "-"]
    raw = subprocess.run(command, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def chroma(data: np.ndarray) -> np.ndarray:
    usable = 1 + (len(data) - SIZE) // HOP
    if usable <= 0:
        return np.zeros((0, BANDS), dtype=np.float32)
    indices = np.arange(SIZE)[None, :] + HOP * np.arange(usable)[:, None]
    frames = data[indices] * np.hanning(SIZE)[None, :]
    spectrum = np.abs(np.fft.rfft(frames, axis=1))
    freqs = np.fft.rfftfreq(SIZE, 1 / RATE)
    keep = (freqs > 110) & (freqs < 1200)
    spectrum, freqs = spectrum[:, keep], freqs[keep]
    midi = np.round(12 * np.log2(freqs / 440.0) + 69).astype(int) % 12
    result = np.zeros((usable, BANDS), dtype=np.float32)
    for band in range(BANDS):
        result[:, band] = spectrum[:, midi == band].sum(axis=1)
    result = np.log1p(result)
    result -= result.mean(axis=1, keepdims=True)
    norm = np.linalg.norm(result, axis=1, keepdims=True)
    return result / np.where(norm > 1e-6, norm, 1)


def fetch_json(url: str):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def deezer_tracks(query: str) -> list[dict]:
    try:
        albums = fetch_json(f"https://api.deezer.com/search/album?q={urllib.parse.quote(query)}")
    except Exception:
        return []
    if not albums.get("data"):
        return []
    album_id = albums["data"][0]["id"]
    album = fetch_json(f"https://api.deezer.com/album/{album_id}")
    tracks = []
    for track in album.get("tracks", {}).get("data", []):
        try:
            full = fetch_json(f"https://api.deezer.com/track/{track['id']}")
        except Exception:
            continue
        tracks.append({
            "artist": (album.get("artist") or {}).get("name"),
            "album": album.get("title"),
            "title": full.get("title") or track.get("title"),
            "duration": full.get("duration") or track.get("duration") or 0,
            "preview": full.get("preview"),
        })
    return tracks


def deezer_track_search(artist: str, title: str = "", limit: int = 25) -> list[dict]:
    """Szuka pojedynczych utworów, gdy nie znamy albumu — wykonawca plus tytuł, jeśli jest."""
    query = " ".join(part for part in (artist, title) if part)
    if not query:
        return []
    try:
        payload = fetch_json(
            f"https://api.deezer.com/search/track?q={urllib.parse.quote(query)}&limit={limit}"
        )
    except Exception:
        return []
    tracks = []
    for item in payload.get("data", [])[:limit]:
        tracks.append({
            "artist": (item.get("artist") or {}).get("name"),
            "album": (item.get("album") or {}).get("title"),
            "title": item.get("title"),
            "duration": item.get("duration") or 0,
            "preview": item.get("preview"),
        })
    return tracks


def preview_pcm(url: str) -> np.ndarray:
    with urllib.request.urlopen(url, timeout=30) as response:
        raw = response.read()
    path = Path("/tmp/resolve-preview.mp3")
    path.write_bytes(raw)
    return ffmpeg_pcm(str(path))


def ask_model(prompt: str) -> tuple[str | None, list[str]]:
    errors: list[str] = []
    tried = 0
    for name, key_env, url, models in PROVIDERS:
        key = os.environ.get(key_env)
        if not key:
            continue
        tried += 1
        for model in models:
            body = json.dumps({
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
            }).encode()
            request = urllib.request.Request(url, data=body, headers={
                "content-type": "application/json",
                "authorization": f"Bearer {key}",
                "user-agent": "ciezko-na-sercu/1.0",
            })
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    payload = json.load(response)
                return payload["choices"][0]["message"]["content"], errors
            except Exception as error:
                print(f"  {name}/{model}: {error}", file=sys.stderr)
                errors.append(f"{name}/{model}: {error}")
    if tried == 0:
        errors.append("brak klucza dostawcy w środowisku")
    return None, errors


def context_text(transcript: dict, start_real: float, seconds: float = 150) -> str:
    window = [s for s in transcript.get("segments", []) if start_real - seconds <= s["start"] < start_real + 5]
    return " ".join(str(s.get("text", "")).strip() for s in window)[-1500:]


def candidate_from_context(text: str) -> tuple[dict | None, str, bool]:
    """Kandydat z zapowiedzi: (utwór, powód niepowodzenia, czy to już pewne)."""
    if not text.strip():
        return None, "brak tekstu", True
    prompt = (
        "Poniżej zapowiedź utworu z audycji radiowej o muzyce metalowej. Podaj wykonawcę i album, "
        "a jeśli w tekście wprost pada tytuł utworu — też tytuł. Nie zgaduj; jeśli czegoś nie ma, zostaw puste.\n"
        'Odpowiedz wyłącznie JSON-em: {"artist": "...", "album": "...", "title": "..."}\n\n'
        f"TEKST:\n{text}"
    )
    answer, errors = ask_model(prompt)
    if not answer:
        return None, "model nie odpowiedział: " + "; ".join(errors[:2]), False
    match = re.search(r"\{.*\}", answer, re.S)
    if not match:
        return None, f"model oddał nie-JSON: {answer[:80]}", False
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None, f"model oddał niepoprawny JSON: {answer[:80]}", False
    artist = str(data.get("artist") or "").strip()
    album = str(data.get("album") or "").strip()
    title = str(data.get("title") or "").strip()
    if not artist:
        return None, f"w kontekście nie ma wykonawcy (model: {answer.strip()[:80]})", True
    return {"artist": artist, "album": album, "title": title}, "", True


def match_gap(gap: np.ndarray, tracks: list[dict]) -> list[dict]:
    gap_chroma = chroma(gap)
    scores = []
    for track in tracks:
        if not track.get("preview"):
            continue
        try:
            preview = chroma(preview_pcm(track["preview"]))
        except Exception:
            continue
        if len(preview) == 0 or len(preview) > len(gap_chroma):
            continue
        best = -1.0
        best_at = 0
        for offset in range(0, len(gap_chroma) - len(preview) + 1):
            value = float((gap_chroma[offset:offset + len(preview)] * preview).sum()) / len(preview)
            if value > best:
                best, best_at = value, offset
        scores.append({**track, "score": round(best, 3), "at": round(best_at * HOP / RATE, 1)})
    scores.sort(key=lambda item: item["score"], reverse=True)
    return scores


def resolve_episode(episode_id: str, write: bool, min_score: float, retry_misses: bool = False) -> None:
    catalog = read_json(ROOT / "data" / "catalog.json")
    entry = next((e for e in catalog["episodes"] if e["id"] == episode_id), None)
    if not entry:
        print(f"{episode_id[:8]}: brak w katalogu")
        return

    override_path = ROOT / "data" / "overrides" / f"{episode_id}.json"
    override = read_json(override_path) or {"version": 1}
    episode_path = ROOT / "data" / "episodes" / f"{episode_id}.json"
    episode = read_json(episode_path) or {}
    transcript = read_json(ROOT / "data" / "transcripts" / f"{episode_id}.json") or {}
    scale = 1.0
    if episode.get("audioDurationSec") and episode.get("durationSec"):
        scale = episode["durationSec"] / episode["audioDurationSec"]

    # Ręcznie dodany utwór ma flagę `unrecognized`; starsze wpisy mają jeszcze tytuł #TODO.
    # `contextMiss` znaczy „kontekst już pytany i nic z tego” — nie pytamy drugi raz.
    def unresolved(track: dict) -> bool:
        if track.get("contextMiss") and not retry_misses:
            return False
        return bool(track.get("unrecognized") or re.search(r"#TODO", track.get("title") or ""))

    override_gaps = [
        track
        for track in (override.get("addTracks") or []) + (override.get("tracks") or [])
        if unresolved(track)
    ]
    # Shazam czasem rozpoznaje tylko wykonawcę — taki utwór z epizodu też jest do naprawy.
    fixed_starts = {
        round(float(fix["start"]), 2)
        for fix in override.get("tracks", [])
        if fix.get("newTitle") and fix.get("start") is not None
    }
    episode_gaps = [
        track
        for track in episode.get("tracks", [])
        if (track.get("contextMiss") and retry_misses)
        or (
            not track.get("contextMiss")
            and (
                not (track.get("title") or "").strip()
                or track.get("unrecognized")
                or re.search(r"#TODO", track.get("title") or "")
            )
        )
    ]
    episode_gaps = [track for track in episode_gaps if round(float(track["start"]), 2) not in fixed_starts]

    # Zbiór tego, co w tym odcinku jest już rozpoznane — chroma czasem wskazuje
    # ten sam utwór drugi raz, a wtedy wolałaby go dopisać obok istniejącego.
    known = set()

    def key(artist, title):
        return ((artist or "").strip().lower(), (title or "").strip().lower())

    for track in episode.get("tracks", []):
        title = (track.get("title") or "").strip()
        if title and not re.search(r"#TODO", title):
            known.add(key(track.get("artist"), title))
    for track in (override.get("addTracks") or []) + (override.get("tracks") or []):
        title = (track.get("newTitle") or track.get("title") or "").strip()
        artist = track.get("newArtist") or track.get("artist")
        if title and not re.search(r"#TODO", title):
            known.add(key(artist, title))

    if not override_gaps and not episode_gaps:
        return

    print(f"{entry['slug']}: {len(override_gaps) + len(episode_gaps)} utworów bez rozpoznania")
    audio = None

    def resolve(gap: dict):
        nonlocal audio
        start_player = float(gap["start"])
        length = float(gap.get("durationSec") or 0)
        start_real = start_player / scale if scale else start_player
        print(f"  {start_player:.0f} s (+{length:.0f} s)")

        text = context_text(transcript, start_real)
        if not text.strip():
            print("    brak tekstu w transkrypcie wokół tego czasu — zostawiam")
            return MISS
        candidate, why, definitive = candidate_from_context(text)
        if not candidate:
            print(f"    {why} — zostawiam")
            return MISS if definitive else None
        print(f"    kontekst: {candidate['artist']} | {candidate['album']} | {candidate['title']}")

        query = " ".join(part for part in (candidate["artist"], candidate["album"]) if part)
        found = deezer_tracks(query)
        if not found:
            found = deezer_track_search(candidate["artist"], candidate["title"])
            if found:
                print(f"    bez albumu — szukam po utworach ({len(found)})")
        if not found:
            print("    brak albumu i utworów w Deezerze — zapamiętuję")
            return MISS

        if audio is None:
            if not entry.get("audioUrl"):
                print("    brak adresu audio — zostawiam")
                return None
            audio = ffmpeg_pcm(entry["audioUrl"])
        from_sample = int(start_real * RATE)
        gap_audio = audio[from_sample:from_sample + int(length * RATE)]
        ranked = match_gap(gap_audio, found)
        repeated = [item for item in ranked if key(item["artist"], item["title"]) in known]
        if repeated:
            print("    odrzucam kandydatów, którzy już są w tym odcinku")
        ranked = [item for item in ranked if key(item["artist"], item["title"]) not in known]
        if not ranked:
            print("    brak podglądów do porównania — zapamiętuję")
            return MISS

        best = ranked[0]
        second = ranked[1]["score"] if len(ranked) > 1 else 0.0
        print(f"    chroma: {best['score']:+.3f} (drugi {second:+.3f}) → {best['artist']} — {best['title']} [{best['album']}]")
        if best["score"] < min_score or best["score"] - second < 0.05:
            print("    za słabe dopasowanie — zapamiętuję do ręcznej decyzji")
            return MISS

        return best, ranked, candidate, start_player, length

    override_changed = False
    for gap in sorted(override_gaps, key=lambda t: t["start"]):
        result = resolve(gap)
        if result is MISS:
            gap["contextMiss"] = True
            override_changed = True
            continue
        if not result:
            continue
        best, ranked, candidate, start_player, length = result

        gap["artist"] = best["artist"]
        gap["title"] = best["title"]
        gap["album"] = best["album"]
        gap.pop("unrecognized", None)
        gap.pop("contextMiss", None)
        known.add(key(best["artist"], best["title"]))
        if candidate["title"] and candidate["title"].lower() == str(best["title"]).lower():
            print("    tytuł zgodny z zapowiedzią")
        override_changed = True

        # Dwie piosenki w jednym bloku: drugie mocne trafienie z innym przesunięciem.
        strong = [
            item
            for item in ranked[1:]
            if item["score"] >= 0.9 and item["at"] > best["at"] + 30 and key(item["artist"], item["title"]) not in known
        ]
        if strong:
            extra = strong[0]
            print(f"    drugi utwór w bloku: {extra['artist']} — {extra['title']}")
            override.setdefault("addTracks", []).append({
                "artist": extra["artist"],
                "title": extra["title"],
                "album": extra["album"],
                "start": round(start_player + float(best.get("duration") or 0), 2),
                "durationSec": round(length - float(best.get("duration") or 0), 2),
            })
            known.add(key(extra["artist"], extra["title"]))
            gap["durationSec"] = round(float(best.get("duration") or length), 2)

    episode_changed = False
    for gap in sorted(episode_gaps, key=lambda t: t["start"]):
        result = resolve(gap)
        if result is MISS:
            gap["contextMiss"] = True
            episode_changed = True
            continue
        if not result:
            continue
        best = result[0]
        gap["artist"] = best["artist"]
        gap["title"] = best["title"]
        gap["album"] = best["album"]
        gap.pop("unrecognized", None)
        gap.pop("contextMiss", None)
        known.add(key(best["artist"], best["title"]))
        episode_changed = True

    if override_changed and write:
        write_json(override_path, override)
        print(f"  zapisane: {override_path}")
    if episode_changed and write:
        write_json(episode_path, episode)
        print(f"  zapisane: {episode_path}")
    if (override_changed or episode_changed) and not write:
        print("  bez --write nic nie zapisałem")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--episode", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--min-score", type=float, default=MIN_SCORE)
    parser.add_argument("--retry-misses", action="store_true")
    args = parser.parse_args()

    catalog = read_json(ROOT / "data" / "catalog.json")
    ids = [e["id"] for e in catalog["episodes"]]
    if args.episode:
        wanted = []
        for key in args.episode:
            exact = [i for i in ids if i == key]
            prefix = [i for i in ids if i.startswith(key)]
            wanted.extend(exact or prefix[:1])
        ids = wanted
    elif not args.all:
        parser.error("podaj --episode albo --all")

    for episode_id in ids:
        resolve_episode(episode_id, args.write, args.min_score, args.retry_misses)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
