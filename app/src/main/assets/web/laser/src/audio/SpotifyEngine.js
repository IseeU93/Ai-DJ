// ============================================================
// SpotifyEngine.js – Integration der Spotify Web API
// BPM- und Struktur-Erkennung durch Auslesen des aktuellen Songs.
// ============================================================

const SPOTIFY_CLIENT_ID = 'YOUR_SPOTIFY_CLIENT_ID_HERE'; 
const REDIRECT_URI = window.location.origin + window.location.pathname; // z.B. http://localhost:3000/

export class SpotifyEngine {
  constructor() {
    this.accessToken = null;
    this.currentTrackId = null;
    
    // Extrahierte Daten
    this.bpm = null;
    this.energy = null;
    this.danceability = null;
    this.sections = []; // Array von { start, duration, loudness }
    this.currentSectionIndex = -1;
    this.progressMs = 0;
    this.isPlaying = false;
    
    this._pollInterval = null;
    this.onTrackChange = null;
    this.onSectionChange = null;
  }

  // 1. Authentifizierung prüfen (wird beim Laden der Seite gerufen)
  checkAuth() {
    // Schauen, ob ein Token in der URL steht (Rückkehr vom Login)
    const hash = window.location.hash;
    if (hash && hash.includes('access_token')) {
      const params = new URLSearchParams(hash.substring(1));
      this.accessToken = params.get('access_token');
      // URL säubern
      window.history.replaceState('', document.title, window.location.pathname);
      this.startPolling();
      return true;
    }
    return false;
  }

  // 2. Login URL generieren
  login() {
    if (SPOTIFY_CLIENT_ID === 'YOUR_SPOTIFY_CLIENT_ID_HERE') {
      alert('Bitte trage zuerst deine Spotify Client ID in src/audio/SpotifyEngine.js ein!');
      return;
    }
    const scope = encodeURIComponent('user-read-currently-playing user-read-playback-state');
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=token&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}`;
    window.location.href = authUrl;
  }

  // 3. Polling starten
  startPolling() {
    if (this._pollInterval) clearInterval(this._pollInterval);
    this._pollInterval = setInterval(() => this._fetchCurrentlyPlaying(), 3000);
    this._fetchCurrentlyPlaying();
  }
  
  stopPolling() {
    if (this._pollInterval) clearInterval(this._pollInterval);
    this.accessToken = null;
  }

  // 4. Aktuellen Song abfragen
  async _fetchCurrentlyPlaying() {
    if (!this.accessToken) return;

    try {
      const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });
      
      if (res.status === 204) {
        // Nichts spielt
        this.isPlaying = false;
        return;
      }
      
      if (res.status === 401) {
        // Token expired
        this.stopPolling();
        alert('Spotify Login abgelaufen. Bitte neu verbinden.');
        return;
      }
      
      const data = await res.json();
      this.isPlaying = data.is_playing;
      this.progressMs = data.progress_ms;

      if (data.item && data.item.id !== this.currentTrackId) {
        this.currentTrackId = data.item.id;
        console.log('[Spotify] Neuer Track erkannt:', data.item.name);
        await this._fetchAudioFeatures(this.currentTrackId);
        await this._fetchAudioAnalysis(this.currentTrackId);
        if (this.onTrackChange) this.onTrackChange(data.item);
      }
      
      this._checkSectionProgress();
      
    } catch (e) {
      console.error('[Spotify] Fehler beim Polling:', e);
    }
  }

  // 5. Audio Features holen (BPM, Energy)
  async _fetchAudioFeatures(id) {
    try {
      const res = await fetch(`https://api.spotify.com/v1/audio-features/${id}`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });
      const data = await res.json();
      this.bpm = data.tempo;
      this.energy = data.energy;
      this.danceability = data.danceability;
      console.log(`[Spotify] BPM: ${this.bpm}, Energy: ${this.energy}`);
    } catch (e) {
      console.error('[Spotify] Fehler bei Audio Features:', e);
    }
  }

  // 6. Audio Analysis holen (Sections/Drops)
  async _fetchAudioAnalysis(id) {
    try {
      const res = await fetch(`https://api.spotify.com/v1/audio-analysis/${id}`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });
      const data = await res.json();
      this.sections = data.sections || [];
      this.currentSectionIndex = -1;
      console.log(`[Spotify] ${this.sections.length} Sections gefunden.`);
    } catch (e) {
      console.error('[Spotify] Fehler bei Audio Analysis:', e);
    }
  }

  // 7. Prüfen ob wir in eine neue musikalische Sektion springen
  _checkSectionProgress() {
    if (!this.sections.length || !this.isPlaying) return;
    
    const progressSec = this.progressMs / 1000;
    let newIndex = -1;
    
    for (let i = 0; i < this.sections.length; i++) {
      const sec = this.sections[i];
      if (progressSec >= sec.start && progressSec < (sec.start + sec.duration)) {
        newIndex = i;
        break;
      }
    }
    
    if (newIndex !== -1 && newIndex !== this.currentSectionIndex) {
      this.currentSectionIndex = newIndex;
      const currentSection = this.sections[newIndex];
      // Wenn die Lautstärke (loudness) stark ansteigt, ist es oft ein Drop
      const isLoud = currentSection.loudness > -8.0; 
      if (this.onSectionChange) this.onSectionChange(currentSection, isLoud);
      console.log(`[Spotify] Neue Section! Loudness: ${currentSection.loudness}`);
    }
  }
}
