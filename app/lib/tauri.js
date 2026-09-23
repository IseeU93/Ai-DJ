// Dünne Hülle um die Rust-Commands (src-tauri/src/main.rs).
const invoke = (...args) => window.__TAURI__.core.invoke(...args);

export const pickFolder = () => invoke('pick_folder');
export const scanFolder = (path) => invoke('scan_folder', { path });

export async function readFile(path) {
  const data = await invoke('read_file', { path });
  // Tauri liefert Response-Bytes als ArrayBuffer (ältere Versionen als Zahlen-Array)
  if (data instanceof ArrayBuffer) return data;
  return new Uint8Array(data).buffer;
}
