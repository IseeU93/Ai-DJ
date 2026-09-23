"""DJ-Mix-Engine: lädt Tracks in voller Qualität, synct Tempo, baut Übergänge mit
Beat-Loops und Bass-Swap-EQ (nicht nur reiner Crossfade)."""
from __future__ import annotations

import numpy as np
import librosa
from scipy.signal import butter, sosfilt

from .analyze import TrackAnalysis

RENDER_SR = 44100
MAX_STRETCH = 0.12  # max. +/-12% Tempoangleichung, danach lieber Beat-Loop-Trick statt Zerrer
TRANSITION_BARS = 8  # Länge des Übergangs in Takten (4/4, angenommen)


def load_render_audio(path: str) -> np.ndarray:
    """Lädt eine Datei in Stereo bei RENDER_SR für die finale Mischung."""
    y, _ = librosa.load(path, sr=RENDER_SR, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    return y.astype(np.float32)  # shape (2, n_samples)


def _lowpass(x: np.ndarray, sr: int, cutoff: float) -> np.ndarray:
    sos = butter(2, cutoff, btype="lowpass", fs=sr, output="sos")
    return sosfilt(sos, x, axis=-1).astype(np.float32)


def _highpass(x: np.ndarray, sr: int, cutoff: float) -> np.ndarray:
    sos = butter(2, cutoff, btype="highpass", fs=sr, output="sos")
    return sosfilt(sos, x, axis=-1).astype(np.float32)


def _time_stretch_stereo(y: np.ndarray, rate: float) -> np.ndarray:
    if abs(rate - 1.0) < 1e-3:
        return y
    return np.stack([librosa.effects.time_stretch(ch, rate=rate) for ch in y])


def _beat_length_seconds(bpm: float) -> float:
    return 60.0 / max(bpm, 1.0)


def _make_loop_buffer(y: np.ndarray, sr: int, start_sample: int, loop_len_samples: int,
                       repeats: int) -> np.ndarray:
    """Klassischer DJ-'Beat-Loop': ein kurzer Abschnitt wird mehrfach wiederholt und dabei
    per Lowpass zunehmend gedämpft, während der nächste Track einsetzt (statt hartem Cut)."""
    loop_len_samples = max(loop_len_samples, 1)
    end = min(start_sample + loop_len_samples, y.shape[1])
    segment = y[:, start_sample:end]
    if segment.shape[1] == 0:
        return np.zeros((2, 0), dtype=np.float32)

    pieces = []
    for i in range(repeats):
        cutoff = max(500.0, 16000.0 * (1.0 - i / max(repeats - 1, 1)) ** 2)
        piece = _lowpass(segment, sr, min(cutoff, sr / 2 - 100))
        fade = np.linspace(1.0, max(0.0, 1.0 - i / repeats * 0.15), piece.shape[1], dtype=np.float32)
        pieces.append(piece * fade)
    return np.concatenate(pieces, axis=1)


def _equal_power_fade(n: int) -> tuple[np.ndarray, np.ndarray]:
    t = np.linspace(0, np.pi / 2, n, dtype=np.float32)
    fade_out = np.cos(t)
    fade_in = np.sin(t)
    return fade_out, fade_in


def build_transition(
    outgoing: np.ndarray, outgoing_info: TrackAnalysis,
    incoming: np.ndarray, incoming_info: TrackAnalysis,
    sr: int = RENDER_SR,
) -> tuple[np.ndarray, int, int]:
    """Erzeugt den Übergang zwischen zwei Tracks.

    Returns (transition_audio, outgoing_body_end_sample, incoming_body_start_sample):
    - outgoing_body_end_sample: bis zu diesem Sample (exklusiv) gehört outgoing noch unvermischt
      vor den Übergang.
    - incoming_body_start_sample: ab diesem Sample geht es nach dem Übergang unvermischt mit
      incoming weiter.
    """
    beat_len = _beat_length_seconds(outgoing_info.bpm or incoming_info.bpm or 120.0)
    transition_len_s = max(4.0, beat_len * 4 * TRANSITION_BARS)
    transition_len_s = min(transition_len_s, outgoing_info.duration * 0.4, incoming_info.duration * 0.4)
    transition_len_s = max(transition_len_s, 2.0)
    n = int(transition_len_s * sr)

    out_start_s = max(0.0, outgoing_info.duration - transition_len_s)
    out_start = int(out_start_s * sr)
    outgoing_tail = outgoing[:, out_start:out_start + n]

    in_start_s = min(incoming_info.intro_end, max(0.0, incoming_info.duration - transition_len_s))
    in_start = int(in_start_s * sr)
    incoming_head = incoming[:, in_start:in_start + n]

    # Tempo angleichen: incoming an outgoing anpassen, wenn im Toleranzbereich
    bpm_out = outgoing_info.bpm or 120.0
    bpm_in = incoming_info.bpm or 120.0
    if bpm_in > 0:
        rate = bpm_in / bpm_out  # >1 => incoming ist schneller, muss gestreckt (verlangsamt) werden
        use_stretch = abs(rate - 1.0) <= MAX_STRETCH
    else:
        rate, use_stretch = 1.0, False

    if use_stretch:
        incoming_head = _time_stretch_stereo(incoming_head, rate)

    length = min(outgoing_tail.shape[1], incoming_head.shape[1])
    if length <= 0:
        return np.zeros((2, 0), dtype=np.float32), outgoing.shape[1], in_start
    outgoing_tail = outgoing_tail[:, :length]
    incoming_head = incoming_head[:, :length]
    # incoming wurde ggf. gestreckt -> die tatsächlich verbrauchte Länge im Original-Zeitraster
    # ermitteln (bei use_stretch nutzt der Vocoder 'length' Output-Samples aus 'rate'-fach mehr Input)
    incoming_consumed_samples = int(round(length * rate)) if use_stretch else length

    if not use_stretch:
        # Tempi zu unterschiedlich für sauberes Strecken -> Beat-Loop-Übergang statt Zerr-Crossfade:
        # letzte Takte des outgoing-Tracks werden gelooped + gefiltert ausgeblendet, während
        # incoming klar hereinkommt (klassischer "loop out"-DJ-Trick).
        loop_bars = 2
        loop_len = int(beat_len * 4 * loop_bars * sr)
        repeats = max(2, length // max(loop_len, 1))
        looped = _make_loop_buffer(outgoing, sr, max(0, out_start), loop_len, repeats)
        if looped.shape[1] >= length:
            outgoing_tail = looped[:, :length]
        # ansonsten: mit dem regulären (leicht kürzeren) tail weiterarbeiten

    fade_out, fade_in = _equal_power_fade(length)

    # Bass-Swap-EQ: outgoing verliert im 2. Drittel des Übergangs den Bass,
    # incoming bekommt seinen Bass erst dort voll dazu (klassische DJ-Technik).
    swap_point = int(length * 0.5)
    out_bass_gain = np.ones(length, dtype=np.float32)
    out_bass_gain[swap_point:] = np.linspace(1.0, 0.0, length - swap_point, dtype=np.float32)
    in_bass_gain = np.ones(length, dtype=np.float32)
    in_bass_gain[:swap_point] = np.linspace(0.0, 1.0, swap_point, dtype=np.float32)

    cutoff = min(180.0, sr / 2 - 100)
    out_bass = _lowpass(outgoing_tail, sr, cutoff) * out_bass_gain
    out_rest = outgoing_tail - _lowpass(outgoing_tail, sr, cutoff)
    in_bass = _lowpass(incoming_head, sr, cutoff) * in_bass_gain
    in_rest = incoming_head - _lowpass(incoming_head, sr, cutoff)

    outgoing_eq = out_bass + out_rest
    incoming_eq = in_bass + in_rest

    mixed = outgoing_eq * fade_out + incoming_eq * fade_in
    peak = np.max(np.abs(mixed)) or 1.0
    if peak > 0.99:
        mixed = mixed / peak * 0.99

    incoming_body_start = in_start + incoming_consumed_samples
    return mixed.astype(np.float32), out_start, incoming_body_start
