# AI-DJ Companion (Android)

Handy-App für den AI-DJ / Automix-Mixer (Branch `main`): zeigt, was läuft, den nächsten Übergang und
die Queue, und steuert den Mixer über das Heimnetz (Play/Pause, Jetzt mixen, Länger spielen,
Automix/Autopilot/Freestyle, Lautstärke, Lasershow/Blackout, Queue bearbeiten, 👍/👎 für Übergänge).

- Verbindung: Companion-Server im Mixer (HTTP 7777, PIN; Suche per UDP 7778). Adresse und PIN stehen
  im Mixer oben unter **Handy**.
- Playlist-Warnung (noch 10/3/1 Songs) kommt als Benachrichtigung – die App hält dafür im Hintergrund
  die Verbindung (Vordergrund-Dienst), ganz ohne Cloud.

## Bauen und aufs Handy

```bash
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Code: `app/src/main/java/com/example/ai_dj_companion/` – `DjRepo` (Verbindung), `DjService`
(Hintergrund + Benachrichtigungen), `MainActivity` (Oberfläche).
