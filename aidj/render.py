"""Setzt die geordnete Trackliste zu einem durchgehenden Mix zusammen.
Hält jeweils nur zwei Tracks gleichzeitig im Speicher (Sliding Window)."""
from __future__ import annotations

import soundfile as sf

from .analyze import TrackAnalysis
from .mixer import RENDER_SR, build_transition, load_render_audio


def render_set(order: list[TrackAnalysis], out_path: str, sr: int = RENDER_SR,
               on_progress=None) -> None:
    if not order:
        raise ValueError("Leere Set-Liste.")

    with sf.SoundFile(out_path, mode="w", samplerate=sr, channels=2, subtype="PCM_24") as f:
        prev_info = order[0]
        prev_audio = load_render_audio(prev_info.path)
        prev_start = 0

        for i, next_info in enumerate(order[1:], start=1):
            if on_progress:
                on_progress(i, len(order) - 1, prev_info, next_info)

            next_audio = load_render_audio(next_info.path)
            transition, body_end, next_start = build_transition(
                prev_audio, prev_info, next_audio, next_info, sr
            )
            body = prev_audio[:, prev_start:max(prev_start, body_end)]
            f.write(body.T)
            f.write(transition.T)

            prev_audio, prev_info, prev_start = next_audio, next_info, next_start

        tail = prev_audio[:, prev_start:]
        f.write(tail.T)
