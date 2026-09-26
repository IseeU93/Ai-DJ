//! Companion-Server: Die Handy-App (AI-DJ Companion) verbindet sich über das Heimnetz.
//!
//! - HTTP auf Port 7777, geschützt per 4-stelliger PIN (Header `X-Pin` oder `?pin=`)
//!   - `GET  /api/hello`                 – ohne PIN: "hier läuft AI-DJ" (zum Suchen/Testen)
//!   - `GET  /api/state?since=N&wait=25` – Status + neue Ereignisse; wartet (Long-Polling), bis sich
//!                                        etwas ändert oder `wait` Sekunden um sind
//!   - `POST /api/cmd`                   – Befehl (JSON), wird an das Mixer-Fenster weitergereicht
//! - UDP 7778: Antwort auf "AIDJ?" mit "AIDJ <port> <rechnername>" (automatisches Finden)
//!
//! Den Status liefert das Mixer-Fenster (`companion_push`), Ereignisse wie die Playlist-Warnung
//! kommen über `companion_event` – die App zeigt sie als Benachrichtigung.
//!
//! Abgleich mit dem Handy (Selbst-Modus), ebenfalls nur mit PIN:
//!   - `GET  /api/sync/feedback`      – Bewertungen (Track-Bezüge relativ zum Musik-Ordner)
//!   - `GET  /api/sync/library`       – alle Audiodateien im Musik-Ordner (relativer Pfad, Größe)
//!   - `GET  /api/sync/file?p=…`      – eine Datei herunterladen
//!   - `POST /api/sync/upload?p=…`    – eine Datei vom Handy ablegen (nur neu, nie überschreiben)
//! Alles bleibt im Musik-Ordner, nur Audiodateien, keine `..`-Pfade.

use serde::Serialize;
use std::io::Read;
use std::net::UdpSocket;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub const PORT: u16 = 7777;
const DISCOVERY_PORT: u16 = 7778;
const MAX_EVENTS: usize = 50;

#[derive(Default)]
struct Inner {
    seq: u64,
    state: String,
    events: Vec<(u64, String)>,
}

pub struct Companion {
    inner: Mutex<Inner>,
    changed: Condvar,
    pin: String,
    last_seen: Mutex<Option<Instant>>,
    /// Musik-Ordner und Bewertungen (JSON), gemeldet vom Mixer-Fenster (`sync_set`)
    sync: Mutex<(String, String)>,
}

const AUDIO: &[&str] = &["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"];
const MAX_UPLOAD: u64 = 600 * 1024 * 1024;

/// Prozent-Kodierung aus der URL entfernen (UTF-8, '+' als Leerzeichen).
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_audio(p: &std::path::Path) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| AUDIO.contains(&e.to_lowercase().as_str())).unwrap_or(false)
}

/// Relativer Pfad vom Handy -> Datei im Musik-Ordner (nur ohne "..", nur Audio).
fn resolve(root: &str, rel: &str) -> Option<std::path::PathBuf> {
    if root.is_empty() || rel.is_empty() {
        return None;
    }
    let mut path = std::path::PathBuf::from(root);
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains('\\') || part.contains(':') {
            return None;
        }
        path.push(part);
    }
    is_audio(&path).then_some(path)
}

fn walk(dir: &std::path::Path, base: &std::path::Path, depth: usize, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth < 4 {
                walk(&p, base, depth + 1, out);
            }
            continue;
        }
        if !is_audio(&p) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/");
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        out.push(format!(r#"{{"p":{},"size":{},"mtime":{}}}"#, serde_json::to_string(&rel).unwrap(), meta.len(), mtime));
    }
}

#[derive(Serialize)]
pub struct CompanionInfo {
    ip: String,
    port: u16,
    pin: String,
    connected: bool,
}

fn local_ip() -> String {
    // Kein Paket wird verschickt – connect() wählt nur die Netzwerkkarte, über die das Heimnetz läuft
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("8.8.8.8:80").map(|_| s))
        .and_then(|s| s.local_addr())
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn load_or_create_pin(app: &AppHandle) -> String {
    let dir = app.path().app_config_dir().ok();
    let file = dir.as_ref().map(|d| d.join("companion_pin.txt"));
    if let Some(f) = &file {
        if let Ok(p) = std::fs::read_to_string(f) {
            let p = p.trim().to_string();
            if p.len() == 4 && p.chars().all(|c| c.is_ascii_digit()) {
                return p;
            }
        }
    }
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(4711);
    let pin = format!("{:04}", (n / 7 + std::process::id()) % 10000);
    if let (Some(d), Some(f)) = (dir, file) {
        let _ = std::fs::create_dir_all(d);
        let _ = std::fs::write(f, &pin);
    }
    pin
}

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

fn respond(req: tiny_http::Request, code: u16, body: String) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap();
    let cors = tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap();
    let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(code).with_header(header).with_header(cors));
}

impl Companion {
    pub fn push_state(&self, state: String) {
        let mut g = self.inner.lock().unwrap();
        if g.state == state {
            return;
        }
        g.seq += 1;
        g.state = state;
        self.changed.notify_all();
    }

    pub fn push_event(&self, event: String) {
        let mut g = self.inner.lock().unwrap();
        g.seq += 1;
        let seq = g.seq;
        g.events.push((seq, event));
        if g.events.len() > MAX_EVENTS {
            g.events.remove(0);
        }
        self.changed.notify_all();
    }

    pub fn set_sync(&self, root: String, feedback: String) {
        *self.sync.lock().unwrap() = (root, feedback);
    }

    pub fn info(&self) -> CompanionInfo {
        let connected = self.last_seen.lock().unwrap().map(|t| t.elapsed() < Duration::from_secs(40)).unwrap_or(false);
        CompanionInfo { ip: local_ip(), port: PORT, pin: self.pin.clone(), connected }
    }

    fn handle(&self, app: &AppHandle, mut req: tiny_http::Request) {
        let url = req.url().to_string();
        let path = url.split('?').next().unwrap_or("").to_string();
        if path == "/api/hello" {
            let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "PC".into());
            return respond(req, 200, format!(r#"{{"app":"AI-DJ","host":{},"needsPin":true}}"#, serde_json::to_string(&host).unwrap()));
        }
        let pin = req
            .headers()
            .iter()
            .find(|h| h.field.equiv("X-Pin"))
            .map(|h| h.value.as_str().to_string())
            .or_else(|| query(&url, "pin"));
        if pin.as_deref() != Some(self.pin.as_str()) {
            return respond(req, 401, r#"{"error":"PIN falsch"}"#.into());
        }
        *self.last_seen.lock().unwrap() = Some(Instant::now());

        match (req.method(), path.as_str()) {
            (tiny_http::Method::Get, "/api/state") => {
                let since: u64 = query(&url, "since").and_then(|s| s.parse().ok()).unwrap_or(0);
                let wait: u64 = query(&url, "wait").and_then(|s| s.parse().ok()).unwrap_or(0).min(30);
                let deadline = Instant::now() + Duration::from_secs(wait);
                let mut g = self.inner.lock().unwrap();
                while g.seq <= since && Instant::now() < deadline {
                    let left = deadline.saturating_duration_since(Instant::now());
                    g = self.changed.wait_timeout(g, left).unwrap().0;
                }
                let events: Vec<&str> = g.events.iter().filter(|(s, _)| *s > since).map(|(_, e)| e.as_str()).collect();
                let state = if g.state.is_empty() { "null" } else { g.state.as_str() };
                let body = format!(r#"{{"seq":{},"state":{},"events":[{}]}}"#, g.seq, state, events.join(","));
                drop(g);
                respond(req, 200, body);
            }
            (tiny_http::Method::Post, "/api/cmd") => {
                let mut body = String::new();
                let _ = req.as_reader().take(64 * 1024).read_to_string(&mut body);
                if serde_json::from_str::<serde_json::Value>(&body).is_err() {
                    return respond(req, 400, r#"{"error":"kein JSON"}"#.into());
                }
                let _ = app.emit_to("main", "companion-cmd", body);
                respond(req, 200, r#"{"ok":true}"#.into());
            }
            (tiny_http::Method::Get, "/api/sync/feedback") => {
                let (root, fb) = self.sync.lock().unwrap().clone();
                let fb = if fb.trim_start().starts_with('[') { fb } else { "[]".into() };
                respond(req, 200, format!(r#"{{"root":{},"feedback":{}}}"#, serde_json::to_string(&root).unwrap(), fb));
            }
            (tiny_http::Method::Get, "/api/sync/library") => {
                let root = self.sync.lock().unwrap().0.clone();
                if root.is_empty() {
                    return respond(req, 409, r#"{"error":"am PC ist noch kein Musik-Ordner geladen"}"#.into());
                }
                let mut files = Vec::new();
                let base = std::path::PathBuf::from(&root);
                walk(&base, &base, 0, &mut files);
                respond(req, 200, format!("[{}]", files.join(",")));
            }
            (tiny_http::Method::Get, "/api/sync/file") => {
                let root = self.sync.lock().unwrap().0.clone();
                let rel = query(&url, "p").map(|p| decode(&p)).unwrap_or_default();
                match resolve(&root, &rel).and_then(|p| std::fs::File::open(p).ok()) {
                    Some(f) => {
                        let ct = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/octet-stream"[..]).unwrap();
                        let _ = req.respond(tiny_http::Response::from_file(f).with_header(ct));
                    }
                    None => respond(req, 404, r#"{"error":"Datei nicht gefunden"}"#.into()),
                }
            }
            (tiny_http::Method::Post, "/api/sync/upload") => {
                let root = self.sync.lock().unwrap().0.clone();
                let rel = query(&url, "p").map(|p| decode(&p)).unwrap_or_default();
                let Some(target) = resolve(&root, &rel) else {
                    return respond(req, 400, r#"{"error":"Pfad nicht erlaubt"}"#.into());
                };
                if target.exists() {
                    return respond(req, 200, r#"{"ok":true,"skipped":true}"#.into());
                }
                if let Some(dir) = target.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let tmp = target.with_extension("part");
                let result = (|| -> std::io::Result<u64> {
                    let mut f = std::fs::File::create(&tmp)?;
                    let n = std::io::copy(&mut req.as_reader().take(MAX_UPLOAD), &mut f)?;
                    f.sync_all()?;
                    Ok(n)
                })();
                match result {
                    Ok(n) if n > 0 && std::fs::rename(&tmp, &target).is_ok() => {
                        let _ = app.emit_to("main", "companion-cmd", r#"{"cmd":"reloadLibrary"}"#);
                        respond(req, 200, format!(r#"{{"ok":true,"bytes":{n}}}"#));
                    }
                    _ => {
                        let _ = std::fs::remove_file(&tmp);
                        respond(req, 500, r#"{"error":"Speichern fehlgeschlagen"}"#.into());
                    }
                }
            }
            _ => respond(req, 404, r#"{"error":"unbekannt"}"#.into()),
        }
    }
}

pub fn start(app: &AppHandle) -> Arc<Companion> {
    let comp = Arc::new(Companion {
        inner: Mutex::new(Inner::default()),
        changed: Condvar::new(),
        pin: load_or_create_pin(app),
        last_seen: Mutex::new(None),
        sync: Mutex::new((String::new(), String::from("[]"))),
    });

    // HTTP
    {
        let comp = comp.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let server = match tiny_http::Server::http(("0.0.0.0", PORT)) {
                Ok(s) => Arc::new(s),
                Err(e) => {
                    eprintln!("Companion-Server konnte Port {PORT} nicht öffnen: {e}");
                    return;
                }
            };
            for req in server.incoming_requests() {
                let comp = comp.clone();
                let app = app.clone();
                // eigener Thread pro Anfrage: Long-Polling blockiert sonst alle anderen
                std::thread::spawn(move || comp.handle(&app, req));
            }
        });
    }

    // UDP-Suche
    std::thread::spawn(|| {
        let Ok(sock) = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) else { return };
        let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "PC".into());
        let mut buf = [0u8; 64];
        while let Ok((n, from)) = sock.recv_from(&mut buf) {
            if &buf[..n.min(5)] == b"AIDJ?" {
                let _ = sock.send_to(format!("AIDJ {PORT} {host}").as_bytes(), from);
            }
        }
    });

    comp
}
