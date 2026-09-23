// Kein Konsolenfenster im Release-Build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::ipc::Response;

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"];
const MAX_DEPTH: usize = 4;

#[derive(Serialize)]
struct AudioFile {
    path: String,
    name: String,
    size: u64,
    modified: u64,
}

fn collect(dir: &Path, depth: usize, out: &mut Vec<AudioFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth < MAX_DEPTH {
                collect(&path, depth + 1, out);
            }
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(AudioFile {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            modified,
        });
    }
}

/// Listet alle Audiodateien eines Ordners (inkl. Unterordner bis MAX_DEPTH).
#[tauri::command]
fn scan_folder(path: String) -> Result<Vec<AudioFile>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("'{path}' ist kein Ordner"));
    }
    let mut files = Vec::new();
    collect(&root, 0, &mut files);
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(files)
}

/// Liefert die Rohbytes einer Datei als ArrayBuffer ans Frontend (ohne JSON-Umweg).
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
async fn pick_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Musikordner wählen")
        .pick_folder()
        .await
        .map(|f| f.path().to_string_lossy().into_owned())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![scan_folder, read_file, pick_folder])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der App");
}
