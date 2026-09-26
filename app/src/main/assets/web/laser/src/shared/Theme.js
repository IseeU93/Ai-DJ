// ============================================================
// Theme.js – Dark/Light Theme mit localStorage-Speicherung
// ============================================================

const STORAGE_KEY = 'laserShow.theme';

export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const theme = saved === 'light' || saved === 'dark' ? saved : 'dark';
  applyTheme(theme);

  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEY, theme);
}
