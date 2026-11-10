#!/usr/bin/env python3
"""Profil głosu prowadzącego: VAD + embeddingi mówcy dla jednego odcinka.

Wypluwa JSON z blokami mowy i przypisanym mówcą (prowadzący / inny) oraz
podsumowanie pokrycia tematami — czyli gdzie w audycji ktoś mówi, a nie ma wejścia.
"""

import argparse
import json
import subprocess
import sys
import unicodedata
from pathlib import Path

import numpy as np
import torch

SAMPLE_RATE = 16000
MIN_SPAN_SEC = 0.6
EMBED_WINDOW_SEC = 6.0


def decode_audio(url: str) -> np.ndarray:
    cmd = [
        'ffmpeg', '-nostdin', '-v', 'error',
        '-i', url,
        '-ac', '1', '-ar', str(SAMPLE_RATE),
        '-f', 's16le', '-',
    ]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def speech_spans(audio: np.ndarray) -> list[dict]:
    model, utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad', model='silero_vad', trust_repo=True, onnx=False
    )
    get_speech_timestamps = utils[0]
    tensor = torch.from_numpy(audio)
    stamps = get_speech_timestamps(
        tensor, model, sampling_rate=SAMPLE_RATE,
        min_speech_duration_ms=400, min_silence_duration_ms=350, speech_pad_ms=80,
    )
    return [
        {'start': s['start'] / SAMPLE_RATE, 'end': s['end'] / SAMPLE_RATE}
        for s in stamps
    ]


def embedder(cache_dir: Path):
    from speechbrain.inference.speaker import EncoderClassifier

    return EncoderClassifier.from_hparams(
        source='speechbrain/spkrec-ecapa-voxceleb',
        savedir=str(cache_dir / 'ecapa'),
        run_opts={'device': 'cpu'},
    )


def embed(model, audio: np.ndarray, span: dict) -> np.ndarray | None:
    start = span['start']
    length = min(span['end'] - start, EMBED_WINDOW_SEC)
    if length < MIN_SPAN_SEC:
        return None
    clip = audio[int(start * SAMPLE_RATE):int((start + length) * SAMPLE_RATE)]
    if clip.size < MIN_SPAN_SEC * SAMPLE_RATE:
        return None
    with torch.no_grad():
        vector = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze().numpy()
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 0 else None


def two_means(matrix: np.ndarray, iterations: int = 25) -> np.ndarray:
    centre = matrix.mean(axis=0)
    first = int(np.argmax(((matrix - centre) ** 2).sum(axis=1)))
    second = int(np.argmax(((matrix - matrix[first]) ** 2).sum(axis=1)))
    centroids = np.stack([matrix[first], matrix[second]])
    labels = np.zeros(len(matrix), dtype=int)
    for _ in range(iterations):
        distances = ((matrix[:, None, :] - centroids[None, :, :]) ** 2).sum(axis=2)
        updated = distances.argmin(axis=1)
        if np.array_equal(updated, labels):
            break
        labels = updated
        for index in (0, 1):
            members = matrix[labels == index]
            if len(members) > 0:
                centroids[index] = members.mean(axis=0)
    return labels


def normalise(text: str) -> str:
    return unicodedata.normalize('NFKC', text).strip().lower()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--id', required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--episode', help='data/episodes/<id>.json — do pokrycia tematami')
    parser.add_argument('--transcript', help='data/transcripts/<id>.json')
    parser.add_argument('--out', required=True)
    parser.add_argument('--cache', default='.cache/voiceprint')
    parser.add_argument('--max-spans', type=int, default=0)
    args = parser.parse_args()

    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)

    print(f'[{args.id}] pobieram audio…', file=sys.stderr)
    audio = decode_audio(args.url)
    duration = len(audio) / SAMPLE_RATE
    print(f'[{args.id}] {duration:.1f} s audio, szukam mowy…', file=sys.stderr)

    spans = speech_spans(audio)
    if args.max_spans > 0:
        spans = spans[: args.max_spans]
    print(f'[{args.id}] bloków mowy: {len(spans)}', file=sys.stderr)

    model = embedder(cache)
    vectors: list[np.ndarray] = []
    kept: list[dict] = []
    for span in spans:
        vector = embed(model, audio, span)
        if vector is None:
            continue
        vectors.append(vector)
        kept.append(span)

    if len(kept) < 2:
        payload = {'episodeId': args.id, 'durationSec': round(duration, 2), 'spans': [], 'summary': {'speechBlocks': len(spans), 'embedded': len(kept)}}
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
        return 0

    matrix = np.stack(vectors)
    labels = two_means(matrix)
    lengths = np.zeros(2)
    for label, span in zip(labels, kept):
        lengths[label] += span['end'] - span['start']
    host = int(lengths.argmax())
    centroids = np.stack([matrix[labels == index].mean(axis=0) for index in (0, 1)])
    centroids /= np.linalg.norm(centroids, axis=1, keepdims=True)

    HOST_THRESHOLD = 0.65

    for index, span in enumerate(kept):
        score = float(matrix[index] @ centroids[labels[index]])
        span['speaker'] = 'prowadzacy' if labels[index] == host and score >= HOST_THRESHOLD else 'niepewne'
        span['start'] = round(span['start'], 2)
        span['end'] = round(span['end'], 2)
        span['score'] = round(score, 4)

    topics: list[dict] = []
    tracks: list[dict] = []
    if args.episode and Path(args.episode).exists():
        episode = json.loads(Path(args.episode).read_text())
        topics = episode.get('topics') or []
        tracks = episode.get('tracks') or []

    items = sorted(
        [{'start': float(t['start']), 'end': float(t['end']) if t.get('end') is not None else None} for t in topics + tracks],
        key=lambda item: item['start'],
    )
    # Utwory bez własnego `end` kończą się na starcie następnej pozycji programu.
    for index, item in enumerate(items):
        if item['end'] is None or item['end'] <= item['start']:
            following = next((other['start'] for other in items[index + 1:] if other['start'] > item['start']), duration)
            item['end'] = following
    gaps = []
    cursor = 0.0
    for item in items:
        if item['start'] > cursor:
            gaps.append((cursor, item['start']))
        cursor = max(cursor, item['end'])
    gaps.append((cursor, duration))

    # Mówca w martwym polu między pozycjami programu to brakujące wejście;
    # mówca „w utworze” to najczęściej zapowiedź albo mówienie po muzyce.
    uncovered = []
    talk_over = 0.0
    for span in kept:
        if span['speaker'] != 'prowadzacy':
            continue
        middle = (span['start'] + span['end']) / 2
        inside_topic = any(float(t['start']) <= middle <= float(t.get('end') or float(t['start']) + 60) for t in topics)
        if inside_topic:
            continue
        inside_track = any(float(t['start']) <= middle < float(t.get('end') or float(t['start'])) for t in tracks)
        if inside_track:
            talk_over += span['end'] - span['start']
            continue
        if any(start <= middle <= end for start, end in gaps):
            uncovered.append(span)

    transcript_near = 0
    if args.transcript and Path(args.transcript).exists():
        segments = json.loads(Path(args.transcript).read_text()).get('segments') or []
        for span in uncovered:
            if any(abs(float(s['start']) - span['start']) <= 1.5 for s in segments):
                transcript_near += 1

    payload = {
        'episodeId': args.id,
        'durationSec': round(duration, 2),
        'spans': kept,
        'missingEntries': uncovered,
        'summary': {
            'speechBlocks': len(spans),
            'embedded': len(kept),
            'hostSec': round(float(lengths[host]), 1),
            'otherSec': round(float(lengths[1 - host]), 1),
            'missingEntryCount': len(uncovered),
            'missingWithTranscript': transcript_near,
            'talkOverTracksSec': round(talk_over, 1),
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(payload['summary'], ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
