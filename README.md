# Automix

Windows-Desktop-App (Tauri): Musikordner wählen → Tracks werden analysiert, zu einem Set sortiert
und wie von einem DJ ineinandergemischt.

## Starten

```bash
npm install
npm run dev
```

## Was passiert

- **Analyse** (einmalig pro Datei, danach gecacht): BPM + Beatgrid, Taktanfänge, 8-Takt-Phrasen,
  Sektionen (Intro/Main/Break/Outro), Tonart (Camelot), Gesangsabschnitte, Lautheit.
- **Reihenfolge**: KI-Vorschlag nach Tonart-Kompatibilität, Tempo und Energie-Bogen.
  In der Queue per Drag & Drop, „↑ Als Nächstes“, „×“ entfernen anpassbar; „KI-Reihenfolge“ sortiert neu.
- **Übergänge** (automatisch gewählt, pro Track in der Queue überschreibbar):
  Blend + Bass-Swap · Loop-Roll · Lyrics-Wechsel · Filter-Sweep · Drop-Cut · Echo-Out.
  Immer auf Phrasengrenzen, mit Beatmatching (Keylock, Tonhöhe bleibt) bis ±8 %.
- **Steuerung**: Play/Cue/Sync/Keylock, Loops ¼–16 Takte, pro Kanal EQ mit Kill, Filter,
  VOX (Gesang absenken), Echo, Fader; Crossfader; „Jetzt mixen“; Leertaste = Play/Pause.

## Weitere Funktionen

- **Playlists**: Oberordner wählen, Unterordner erscheinen als Playlists.
- **Musikrichtung** (Pop, Rap, House/EDM, Hardstyle, Uptempo): wird automatisch erkannt und bestimmt,
  wie gemixt wird (Länge, Techniken, Bass-/Kick-Wechsel, Gesangsschutz). Pro Track in der Queue und
  pro Playlist überschreibbar.
- **Key-Sync**: passt die Tonart nicht, wird der neue Track um bis zu ±2 Halbtöne angeglichen.
- **Mix-Punkte** werden gesucht (Sektionswechsel, Drop-Swap, keine abgeschnittenen Gesangszeilen,
  nie mitten im vollen Drop), Übergänge sind vor dem ersten Drop des neuen Tracks fertig.
- **Beatgrid-Korrektur** pro Deck (±5 ms, „1 hier“, ×2/÷2), Hot Cues, Autopilot, Reshuffle,
  „Zum Übergang“ zum schnellen Testen.

## Entwicklung

```bash
npm test                                   # Tests (Deck-DSP, Analyse, Planer, Reihenfolge)
node tools/make-test-tracks.mjs <ordner>   # synthetische Testtracks erzeugen
node tools/dev-server.mjs <ordner>         # UI im Browser testen (simuliert Tauri)
```

Struktur: `app/audio` (Deck-Worklet, Web-Audio-Graph), `app/analysis` (Analyse im Worker),
`app/mix` (Reihenfolge, Übergangs-Planer, Conductor), `app/ui` (Regler, Wellenformen, Zeitleiste),
`src-tauri` (Ordner scannen, Dateien lesen, Ordnerdialog).
