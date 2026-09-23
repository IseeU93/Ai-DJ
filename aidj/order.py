"""Baut aus analysierten Tracks eine DJ-taugliche Set-Reihenfolge:
BPM-Nähe + harmonische Kompatibilität (Camelot Wheel) + sanfter Energie-Bogen."""
from __future__ import annotations

from .analyze import TrackAnalysis


def _camelot_distance(a: str, b: str) -> float:
    """0.0 = perfekt kompatibel, steigt mit Inkompatibilität."""
    if not a or not b:
        return 1.0
    if a == b:
        return 0.0
    try:
        num_a, letter_a = int(a[:-1]), a[-1]
        num_b, letter_b = int(b[:-1]), b[-1]
    except ValueError:
        return 1.0

    if num_a == num_b and letter_a != letter_b:  # relative Dur/Moll (z.B. 8A/8B)
        return 0.2

    diff = min((num_a - num_b) % 12, (num_b - num_a) % 12)
    if diff == 1 and letter_a == letter_b:  # ein Schritt auf dem Wheel
        return 0.3
    if diff == 0:
        return 0.2
    return 0.5 + 0.05 * diff


def _bpm_distance(a: float, b: float) -> float:
    if a <= 0 or b <= 0:
        return 1.0
    ratio = max(a, b) / min(a, b)
    # Halbe/doppelte Tempi (z.B. 90 vs 180) gelten als kompatibel (DJs nutzen das oft)
    if ratio > 1.7:
        ratio /= 2
    return abs(ratio - 1.0)


def _track_distance(a: TrackAnalysis, b: TrackAnalysis) -> float:
    return 0.6 * _bpm_distance(a.bpm, b.bpm) + 0.4 * _camelot_distance(a.camelot, b.camelot)


def build_set_order(tracks: list[TrackAnalysis]) -> list[TrackAnalysis]:
    """Greedy nearest-neighbor Reihenfolge mit Energie-Bogen (ruhiger Start, Peak in der Mitte,
    sanftes Ausklingen), ähnlich wie ein DJ ein Set aufbaut."""
    if len(tracks) <= 2:
        return sorted(tracks, key=lambda t: t.energy)

    remaining = list(tracks)
    # Start: energieärmster Track (ruhiger Einstieg)
    remaining.sort(key=lambda t: t.energy)
    order = [remaining.pop(0)]

    peak_index = max(1, len(tracks) // 2)

    while remaining:
        current = order[-1]
        want_energy_up = len(order) < peak_index

        def score(t: TrackAnalysis) -> float:
            dist = _track_distance(current, t)
            energy_penalty = 0.0
            if want_energy_up and t.energy < current.energy:
                energy_penalty = 0.15
            elif not want_energy_up and t.energy > current.energy:
                energy_penalty = 0.15
            return dist + energy_penalty

        best = min(remaining, key=score)
        order.append(best)
        remaining.remove(best)

    return order
