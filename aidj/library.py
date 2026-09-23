"""Ordner einlesen und alle Tracks analysieren (mit Cache)."""
from __future__ import annotations

import os

from .analyze import AnalysisCache, TrackAnalysis

SUPPORTED_EXTENSIONS = {".mp3", ".wav", ".ogg", ".flac"}


def scan_folder(folder: str) -> list[str]:
    paths = []
    for name in sorted(os.listdir(folder)):
        ext = os.path.splitext(name)[1].lower()
        if ext in SUPPORTED_EXTENSIONS:
            paths.append(os.path.join(folder, name))
    return paths


def analyze_folder(folder: str, use_cache: bool = True, progress=None) -> list[TrackAnalysis]:
    paths = scan_folder(folder)
    if not paths:
        raise FileNotFoundError(
            f"Keine unterstützten Audiodateien in '{folder}' gefunden "
            f"({', '.join(sorted(SUPPORTED_EXTENSIONS))})."
        )

    cache_path = os.path.join(folder, ".aidj_analysis_cache.json")
    cache = AnalysisCache(cache_path if use_cache else "")

    results = []
    for i, path in enumerate(paths, start=1):
        if progress:
            progress(i, len(paths), path)
        results.append(cache.get_or_analyze(path))

    if use_cache:
        cache.save()

    return results
