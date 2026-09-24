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

## Lasershow

Button **Lasershow** (oder Taste `L`) blendet die Beamer-Lasershow neben dem Mixer ein – geteilt
(Breite per Trennlinie ziehen, `⇄` wechselt die Seite) oder als Vollbild (`Esc` zurück).
**Beamer-Fenster** öffnet ein eigenes Fenster für den 2. Monitor/Beamer (dort Doppelklick = Vollbild).

Die Show hört am Mixer-Ausgang mit (Kicks, Snares, Spektrum), die Struktur kommt aber aus der
MP3-Analyse: Takt und Schlag exakt aus dem Beatgrid, Szenenwechsel auf Phrasengrenzen, Spannung im
Build bis zum Drop, Blackout genau vor dem Drop, Farben aus der Tonart, Intensität nach Musikrichtung.
Bei Übergängen wechselt die Show mit dem Bass-Wechsel auf den neuen Track. Der Master-Regler dimmt die
Show nicht. Effekt/Farbe lassen sich auch von Hand wählen (Autopilot aus), `B` = Blackout.

Die Lasershow-Dateien unter `app/laser/src` stammen aus dem Beamer-Lasershow-Projekt; nach Änderungen
dort mit `npm run sync:laser` neu übernehmen (Pfad per `LASERSHOW_DIR`). Die Anbindung an den Mixer
liegt in `app/laser/dj`.

## Handy-App (AI-DJ Companion)

Die Android-App (Projekt `AndroidStudioProjects/AIDJCompanion`) steuert den Mixer über das Heimnetz:
läuft gerade, nächster Übergang, Queue (als Nächstes, verschieben, entfernen), Play/Pause, Jetzt mixen,
Automix/Autopilot/Freestyle, Lautstärke, Lasershow/Blackout, 👍/👎 für Übergänge.

- Mixer: oben **Handy** zeigt Adresse und 4-stellige PIN (bleibt gleich). Windows fragt beim ersten
  Start, ob Automix im privaten Netzwerk erreichbar sein darf – zulassen.
- App: **Im WLAN suchen** (UDP 7778) oder Adresse eingeben, PIN, Verbinden.
- Playlist-Warnung bei noch 10, 3 und 1 Song(s): im Mixer als Hinweis und auf dem Handy als
  Benachrichtigung (die App hält dafür im Hintergrund die Verbindung, ohne Cloud).
- Server: `src-tauri/src/companion.rs` (HTTP 7777, Long-Polling), Brücke im Mixer: `app/lib/companion.js`.

## Entwicklung

```bash
npm test                                   # Tests (Deck-DSP, Analyse, Planer, Reihenfolge)
node tools/make-test-tracks.mjs <ordner>   # synthetische Testtracks erzeugen
node tools/dev-server.mjs <ordner>         # UI im Browser testen (simuliert Tauri)
```

Struktur: `app/audio` (Deck-Worklet, Web-Audio-Graph), `app/analysis` (Analyse im Worker),
`app/mix` (Reihenfolge, Übergangs-Planer, Conductor), `app/ui` (Regler, Wellenformen, Zeitleiste),
`src-tauri` (Ordner scannen, Dateien lesen, Ordnerdialog).
