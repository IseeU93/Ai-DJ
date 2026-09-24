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
