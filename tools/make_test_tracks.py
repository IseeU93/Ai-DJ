"""Erzeugt synthetische Testtracks (Klick + Akkord) mit unterschiedlichem BPM/Tonart,
um die Automix-Pipeline ohne echte (urheberrechtlich geschützte) Musik zu testen."""
import os
import numpy as np
import soundfile as sf

SR = 44100
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "samples")

# (bpm, root_freq, duration_s)
SPECS = [
    (120.0, 220.0, 20),  # A3 -> A minor-ish
    (124.0, 246.94, 20),  # B3
    (128.0, 261.63, 20),  # C4
    (96.0, 196.0, 20),  # G3 (deutlich langsamer -> testet Beat-Loop statt Stretch)
]


def make_track(bpm: float, root: float, duration: float) -> np.ndarray:
    n = int(duration * SR)
    t = np.linspace(0, duration, n, endpoint=False)

    # Akkord (Grundton + Terz + Quinte) als Pad
    chord = (
        0.18 * np.sin(2 * np.pi * root * t)
        + 0.12 * np.sin(2 * np.pi * root * 1.25 * t)
        + 0.12 * np.sin(2 * np.pi * root * 1.5 * t)
    )

    # Kick/Click auf jedem Beat
    beat_len = 60.0 / bpm
    click = np.zeros(n)
    beat_times = np.arange(0, duration, beat_len)
    for bt in beat_times:
        idx = int(bt * SR)
        click_len = int(0.05 * SR)
        if idx + click_len < n:
            env = np.exp(-np.linspace(0, 30, click_len))
            click[idx:idx + click_len] += 0.6 * env * np.sin(2 * np.pi * 90 * np.linspace(0, 0.05, click_len))

    # Energie-Hüllkurve: Intro leiser, Mitte voll, Outro leiser
    env = np.ones(n)
    fade = int(3 * SR)
    env[:fade] = np.linspace(0.2, 1.0, fade)
    env[-fade:] = np.linspace(1.0, 0.2, fade)

    mono = (chord + click) * env
    stereo = np.stack([mono, mono])
    return stereo.astype(np.float32)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for i, (bpm, root, dur) in enumerate(SPECS, start=1):
        audio = make_track(bpm, root, dur)
        path = os.path.join(OUT_DIR, f"test_track_{i}_{int(bpm)}bpm.wav")
        sf.write(path, audio.T, SR)
        print("wrote", path)


if __name__ == "__main__":
    main()
