# AI DJ Mixer

Automatisches DJ-Set aus einem Ordner mit lokalen Audiodateien (mp3/wav/ogg/flac) –
mit echten DJ-Techniken statt nur Crossfade:

- **BPM- & Tonart-Erkennung** (Camelot Wheel) pro Track
- **Automatische Set-Reihenfolge**: harmonisch & tempo-mäßig passende Nachbarn, sanfter
  Energie-Bogen (ruhiger Einstieg → Peak in der Mitte → Ausklang)
- **Tempo-Sync**: Übergänge werden per Time-Stretch aneinander angeglichen (innerhalb ±12%)
- **Beat-Loop-Übergang**: wenn die Tempi zu weit auseinanderliegen für sauberes Stretching,
  wird (wie bei echten DJs) der letzte Loop des auslaufenden Tracks wiederholt und dabei
  gefiltert ausgeblendet, statt einfach hart zu schneiden
- **Bass-Swap-EQ**: der Bass wechselt in der Mitte des Übergangs vom alten zum neuen Track
  (klassische DJ-Technik, klingt deutlich sauberer als reiner Lautstärke-Crossfade)

## Setup

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## Benutzung

```bash
.venv\Scripts\python -m aidj.cli "C:\Pfad\zu\deinem\Musikordner" --export mein_set.wav --play
```

- `--export <datei>`: Zieldatei für den gerenderten Mix (default `automix_output.wav`)
- `--play`: nach dem Rendern direkt abspielen
- `--no-cache`: Analyse-Cache (`.aidj_analysis_cache.json` im Musikordner) ignorieren und neu analysieren

Die Analyse wird pro Ordner gecacht, damit ein zweiter Lauf mit denselben Dateien sofort losrendert.

## Testtracks erzeugen (ohne echte Musik)

```bash
.venv\Scripts\python tools\make_test_tracks.py
.venv\Scripts\python -m aidj.cli samples --export test_output.wav
```

## Aktueller Stand / nächste Schritte

Funktioniert aktuell als Kommandozeilen-Tool (Ordner rein, fertiger Mix raus). Mögliche
nächste Ausbaustufen:

- Grafische Oberfläche (Trackliste, Play-Button, Wellenform)
- Bessere Struktur-Erkennung (echte Intro/Drop/Outro-Segmentierung statt Energie-Heuristik)
- Live-Streaming-Wiedergabe während des Renderns (aktuell: erst rendern, dann abspielen)
- Manuelle Eingriffe (Track ausschließen, Reihenfolge selbst anpassen, Übergangslänge)
