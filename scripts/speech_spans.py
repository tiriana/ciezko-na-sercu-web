#!/usr/bin/env python3
"""Producent artefaktu `speech-spans.json`: gdzie w nagraniu jest mowa.

Silero VAD w wersji ONNX, bez torch: model ma ~2 MB, więc etap jest tani i nie
ciągnie zależności potrzebnych tylko do analizy mówców. Wyjście ma dwa poziomy:
`spans` (prawda VAD, do decyzji o mówcach) i `chunks` (bloki do ASR — sklejone
przerwy w zdaniu, bo whisper.cpp płaci pełne okno 30 s za każdy krótki fragment).

Użycie:
  python3 scripts/speech_spans.py --id <uuid> --url <mp3|wav> --out data/episodes/<iso>_<uuid>/speech-spans.json
  python3 scripts/speech_spans.py --id recog --audio lokalny.mp3 --out /tmp/x.json --no-chunks
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
FRAME = 512  # okno modelu; 64 próbki kontekstu dokładamy przed każdą ramką
CONTEXT = 64
MODEL_URL = "https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx"
MODEL_NAME = "silero_vad_v5.1.2.onnx"

# Te same progi co w voiceprint.py, żeby oba etapy widziały tę samą mowę.
VAD = {
    "threshold": 0.5,
    "min_speech_ms": 400,
    "min_silence_ms": 350,
    "speech_pad_ms": 80,
}

# Bloki do ASR: przerwy krótsze niż 5 s to pauza w zdaniu, nie muzyka.
CHUNKS = {
    "merge_gap_sec": 5.0,
    "max_length_sec": 120.0,
    "pad_sec": 0.5,
}


def decode_audio(source: str) -> np.ndarray:
    command = ["ffmpeg", "-nostdin", "-v", "error"]
    if source.startswith(("http://", "https://")):
        command += ["-i", source]
    else:
        command += ["-i", source]
    command += ["-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"]
    raw = subprocess.run(command, check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def load_model(cache: Path, model_path: Path | None):
    try:
        import onnxruntime as ort
    except ImportError:
        raise SystemExit(
            "Brak onnxruntime. Utwórz środowisko: python3 -m venv .venv-spans && "
            ".venv-spans/bin/pip install numpy onnxruntime, potem ustaw SPANS_PYTHON=.venv-spans/bin/python"
        )

    if model_path is None:
        model_path = cache / MODEL_NAME
        if not model_path.exists():
            cache.mkdir(parents=True, exist_ok=True)
            print(f"pobieram model VAD → {model_path}", file=sys.stderr)
            subprocess.run(["curl", "-fsSL", "-o", str(model_path), MODEL_URL], check=True)
    return ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])


def probabilities(session, audio: np.ndarray, step: float | None = None) -> np.ndarray:
    """Prawdopodobieństwo mowy dla każdej ramki 32 ms; opcjonalnie tylko co `step` s."""
    state = np.zeros((2, 1, 128), dtype=np.float32)
    sr = np.array(SAMPLE_RATE, dtype=np.int64)
    context = np.zeros(CONTEXT, dtype=np.float32)
    frames = int(np.ceil(len(audio) / FRAME))
    stride = 1
    if step:
        stride = max(1, int(round(step * SAMPLE_RATE / FRAME)))
    scores = np.zeros(frames, dtype=np.float32)
    for index in range(frames):
        chunk = audio[index * FRAME : (index + 1) * FRAME]
        if chunk.size < FRAME:
            chunk = np.pad(chunk, (0, FRAME - chunk.size))
        model_input = np.concatenate([context, chunk])[None, :]
        output, state = session.run(None, {"input": model_input, "state": state, "sr": sr})
        scores[index] = float(output[0][0])
        context = chunk[-CONTEXT:]
        if stride > 1 and index % stride == 0:
            # Model wymaga ciągłej ramki; przeskok tylko przy strojeniu, nie w produkcji.
            pass
    return scores


def spans_from_scores(scores: np.ndarray, duration: float) -> list[dict]:
    threshold = VAD["threshold"]
    min_speech = VAD["min_speech_ms"] / 1000
    min_silence = VAD["min_silence_ms"] / 1000
    pad = VAD["speech_pad_ms"] / 1000

    raw: list[list[float]] = []
    for index, score in enumerate(scores):
        start = index * FRAME / SAMPLE_RATE
        if score < threshold:
            continue
        end = min((index + 1) * FRAME / SAMPLE_RATE, duration)
        if raw and start - raw[-1][1] <= min_silence:
            raw[-1][1] = end
        else:
            raw.append([start, end])

    merged = [segment for segment in raw if segment[1] - segment[0] >= min_speech]
    return [
        {"start": round(max(0.0, start - pad), 2), "end": round(min(duration, end + pad), 2)}
        for start, end in merged
    ]


def chunks_from_spans(spans: list[dict], duration: float) -> list[dict]:
    gap = CHUNKS["merge_gap_sec"]
    maximum = CHUNKS["max_length_sec"]
    pad = CHUNKS["pad_sec"]

    groups: list[list[float]] = []
    for span in spans:
        if groups and span["start"] - groups[-1][1] <= gap:
            groups[-1][1] = span["end"]
        else:
            groups.append([span["start"], span["end"]])

    chunks: list[dict] = []
    for start, end in groups:
        start = max(0.0, start - pad)
        end = min(duration, end + pad)
        while end - start > maximum:
            chunks.append({"start": round(start, 2), "end": round(start + maximum, 2)})
            start += maximum
        if end - start > 0.2:
            chunks.append({"start": round(start, 2), "end": round(end, 2)})
    return chunks


def build(source: str, cache: Path, model_path: Path | None, with_chunks: bool = True) -> dict:
    audio = decode_audio(source)
    duration = round(len(audio) / SAMPLE_RATE, 2)
    session = load_model(cache, model_path)
    scores = probabilities(session, audio)
    spans = spans_from_scores(scores, duration)
    payload = {
        "version": 1,
        "audioUrl": source if source.startswith(("http://", "https://")) else None,
        "audioFile": None if source.startswith(("http://", "https://")) else Path(source).name,
        "durationSec": duration,
        "model": MODEL_NAME,
        "params": {"vad": VAD, "chunks": CHUNKS},
        "spans": spans,
        "summary": {
            "speechBlocks": len(spans),
            "speechSec": round(sum(span["end"] - span["start"] for span in spans), 1),
        },
    }
    if with_chunks:
        chunks = chunks_from_spans(spans, duration)
        payload["chunks"] = chunks
        payload["summary"]["chunks"] = len(chunks)
        payload["summary"]["chunkSec"] = round(sum(chunk["end"] - chunk["start"] for chunk in chunks), 1)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True)
    parser.add_argument("--url", help="adres mp3 odcinka")
    parser.add_argument("--audio", help="lokalny plik zamiast adresu")
    parser.add_argument("--out", required=True)
    parser.add_argument("--cache", default=".cache/models")
    parser.add_argument("--model", help="ścieżka do modelu ONNX (domyślnie z cache)")
    parser.add_argument("--no-chunks", action="store_true")
    args = parser.parse_args()

    source = args.audio or args.url
    if not source:
        parser.error("podaj --url albo --audio")

    payload = build(source, Path(args.cache), Path(args.model) if args.model else None, not args.no_chunks)
    payload["episodeId"] = args.id
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    summary = payload["summary"]
    print(
        f"[{args.id}] {payload['durationSec']:.0f} s audio, mowa {summary['speechSec']:.0f} s "
        f"w {summary['speechBlocks']} blokach, do ASR {summary.get('chunks', 0)} odcinków "
        f"({summary.get('chunkSec', 0):.0f} s) → {out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
