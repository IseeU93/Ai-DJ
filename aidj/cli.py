"""Kommandozeilen-Einstieg: Ordner analysieren, Set-Reihenfolge bauen, mixen, abspielen/exportieren."""
from __future__ import annotations

import argparse
import os
import sys
import time

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from .library import analyze_folder
from .order import build_set_order
from .render import render_set


def _progress_analyze(i: int, total: int, path: str) -> None:
    print(f"  [{i}/{total}] analysiere {os.path.basename(path)} ...", flush=True)


def _progress_render(i: int, total: int, a, b) -> None:
    print(f"  [{i}/{total}] Übergang: {os.path.basename(a.path)} -> {os.path.basename(b.path)}"
          f"  ({a.bpm:.0f} BPM {a.camelot} -> {b.bpm:.0f} BPM {b.camelot})", flush=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="AI-DJ: mischt lokale Audiodateien automatisch wie ein DJ (Tempo-Sync, "
                    "Beat-Loops, Bass-Swap-EQ) zu einem durchgehenden Set."
    )
    parser.add_argument("folder", help="Ordner mit Audiodateien (mp3/wav/ogg/flac)")
    parser.add_argument("--export", default="automix_output.wav",
                        help="Zieldatei für den gerenderten Mix (default: automix_output.wav)")
    parser.add_argument("--play", action="store_true", help="Mix nach dem Rendern abspielen")
    parser.add_argument("--no-cache", action="store_true", help="Analyse-Cache ignorieren")
    args = parser.parse_args(argv)

    print(f"Scanne & analysiere '{args.folder}' ...")
    tracks = analyze_folder(args.folder, use_cache=not args.no_cache, progress=_progress_analyze)
    print(f"{len(tracks)} Tracks analysiert.\n")

    order = build_set_order(tracks)
    print("Set-Reihenfolge:")
    for i, t in enumerate(order, start=1):
        print(f"  {i:2d}. {os.path.basename(t.path):40s} {t.bpm:6.1f} BPM  {t.camelot:4s}  "
              f"energy={t.energy:.3f}")
    print()

    print(f"Rendere Mix nach '{args.export}' ...")
    t0 = time.time()
    render_set(order, args.export, on_progress=_progress_render)
    print(f"Fertig in {time.time() - t0:.1f}s -> {args.export}\n")

    if args.play:
        import soundfile as sf
        import sounddevice as sd
        print("Spiele Mix ab (Strg+C zum Abbrechen) ...")
        data, sr = sf.read(args.export, dtype="float32")
        sd.play(data, sr)
        sd.wait()

    return 0


if __name__ == "__main__":
    sys.exit(main())
