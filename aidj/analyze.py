"""Audio-Analyse: BPM, Beatgrid, Tonart (Camelot), Energie-Kurve, Intro/Outro-Punkte."""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, asdict, field

import numpy as np
import librosa

ANALYSIS_SR = 22050  # Analyse-Samplerate (schneller, reicht für BPM/Key/Energie)

# --- Camelot-Wheel-Mapping (Pitch-Class 0=C..11=B) ---
_MAJOR_CAMELOT = {0: "8B", 7: "9B", 2: "10B", 9: "11B", 4: "12B", 11: "1B",
                  6: "2B", 1: "3B", 8: "4B", 3: "5B", 10: "6B", 5: "7B"}
_MINOR_CAMELOT = {9: "8A", 4: "9A", 11: "10A", 6: "11A", 1: "12A", 8: "1A",
                  3: "2A", 10: "3A", 5: "4A", 0: "5A", 7: "6A", 2: "7A"}

_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler Tonart-Profile
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


@dataclass
class TrackAnalysis:
    path: str
    duration: float
    bpm: float
    beat_times: list = field(default_factory=list)
    key_name: str = ""
    camelot: str = ""
    energy: float = 0.0
    intro_end: float = 0.0     # Sekunde, ab der der Track "voll da" ist
    outro_start: float = 0.0   # Sekunde, ab der der Track ausklingt / für Mix-Out geeignet ist
    sr: int = ANALYSIS_SR

    def to_json(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_json(d: dict) -> "TrackAnalysis":
        return TrackAnalysis(**d)


def _estimate_key(y: np.ndarray, sr: int) -> tuple[str, str]:
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    best_score = -np.inf
    best_name = "C"
    best_camelot = "8B"
    for shift in range(12):
        maj = np.roll(_MAJOR_PROFILE, shift)
        minr = np.roll(_MINOR_PROFILE, shift)
        maj_score = np.corrcoef(chroma_mean, maj)[0, 1]
        min_score = np.corrcoef(chroma_mean, minr)[0, 1]
        if maj_score > best_score:
            best_score = maj_score
            best_name = f"{_NOTE_NAMES[shift]} major"
            best_camelot = _MAJOR_CAMELOT[shift]
        if min_score > best_score:
            best_score = min_score
            best_name = f"{_NOTE_NAMES[shift]} minor"
            best_camelot = _MINOR_CAMELOT[shift]
    return best_name, best_camelot


def _estimate_structure(y: np.ndarray, sr: int, duration: float) -> tuple[float, float]:
    """Grobe Intro/Outro-Erkennung über die RMS-Energiehüllkurve."""
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    if len(rms) < 4:
        return 0.0, duration
    smoothed = np.convolve(rms, np.ones(8) / 8, mode="same")
    threshold = 0.6 * np.median(smoothed[smoothed > 0]) if np.any(smoothed > 0) else 0.0
    above = np.where(smoothed >= threshold)[0]
    if len(above) == 0:
        return 0.0, duration
    intro_end = float(times[above[0]])
    outro_start = float(times[above[-1]])
    # sinnvolle Grenzen: Intro max. erste 25%, Outro min. letzte 25% des Tracks
    intro_end = min(intro_end, duration * 0.25)
    outro_start = max(outro_start, duration * 0.75)
    return intro_end, outro_start


def analyze_file(path: str) -> TrackAnalysis:
    y, sr = librosa.load(path, sr=ANALYSIS_SR, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, trim=False)
    bpm = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

    key_name, camelot = _estimate_key(y, sr)
    energy = float(np.sqrt(np.mean(y.astype(np.float64) ** 2)))
    intro_end, outro_start = _estimate_structure(y, sr, duration)

    return TrackAnalysis(
        path=path, duration=duration, bpm=bpm, beat_times=beat_times,
        key_name=key_name, camelot=camelot, energy=energy,
        intro_end=intro_end, outro_start=outro_start, sr=sr,
    )


def _cache_key(path: str) -> str:
    st = os.stat(path)
    raw = f"{path}:{st.st_size}:{st.st_mtime}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


class AnalysisCache:
    """Persistiert Analyseergebnisse pro Ordner, damit man Tracks nicht jedes Mal neu analysiert."""

    def __init__(self, cache_path: str):
        self.cache_path = cache_path
        self._data: dict[str, dict] = {}
        if os.path.exists(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    self._data = json.load(f)
            except (json.JSONDecodeError, OSError):
                self._data = {}

    def get_or_analyze(self, path: str) -> TrackAnalysis:
        key = _cache_key(path)
        if key in self._data:
            return TrackAnalysis.from_json(self._data[key])
        result = analyze_file(path)
        self._data[key] = result.to_json()
        return result

    def save(self) -> None:
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump(self._data, f)
